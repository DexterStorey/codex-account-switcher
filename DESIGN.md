# Design

## System model

The application models provider accounts separately from runtime clients:

```text
Provider accounts                      Runtime clients
┌─────────────────────┐                ┌─────────────────────┐
│ OpenAI              │───────────────▶│ Codex CLI           │
│  account A, B, C    │───────────────▶│ Pi / openai-codex   │
└─────────────────────┘                └─────────────────────┘

┌─────────────────────┐                ┌─────────────────────┐
│ Anthropic           │───────────────▶│ Claude Code         │
│  account D, E, F, G │                └─────────────────────┘
└─────────────────────┘

Pi / Anthropic OAuth is extra-usage billing and is deliberately outside the
Claude Max rotation pool.
```

This prevents usage from being double-counted and avoids inventing a Pi account or Pi rate limit.

## Boundaries

| Boundary | Responsibility | Durable data |
| --- | --- | --- |
| `domain.ts` | Canonical Zod schemas and inferred types | None |
| `storage.ts` | SQLite migrations, validated persistence, atomic commits | Metadata only |
| `providers/codex` | Login, vault, OAuth refresh, usage, app-server, supervisor | Keychain secret |
| `providers/claude` | Profile login, credential compatibility, usage, activation | Claude Keychain profile |
| `extensions/pi.ts` | In-process generation handoff and WebSocket reset | None |
| `selection.ts` | Pure deterministic rotation decision | None |
| `manager.ts` | Probe scheduling and switch transaction orchestration | Via storage |
| `ipc.ts` | Strict local request boundary | Unix socket only |
| `ui.ts` | Read-only terminal projection | None |
| `cli.ts` | Command parsing and composition | None |

Provider-specific response shapes never cross into application code. Each adapter validates its input
and emits an `Account`, `UsageSnapshot`, or explicit application error.

## Durable state

SQLite uses WAL mode, foreign keys, a busy timeout, and JSON payloads validated by their current Zod
schema on every read and write.

```text
accounts ───────────────┐
  id                    │
  provider              ├──▶ usage_snapshots
  validated payload     │      account_id
                        │      observed_at
provider_states         │      validated payload
  provider              │
  active account        └──▶ switch_records
  generation                   phase + source + target
  automation policy

runtime_sessions
  client + provider + generation + state
```

The database contains no access or refresh token. Corrupt payloads raise `CORRUPT_STATE`; they are not
silently treated as an empty store.

## Credential ownership

### OpenAI

Registration runs `codex login` with a temporary `CODEX_HOME`. The resulting `auth.json` is strictly
validated, its account identity is read from JWT claims, and the credential is moved into a dedicated
macOS Keychain item. The temporary directory is then deleted.

The manager is the only refresh owner. Refreshes are serialized per Keychain reference so two probes
cannot submit the same rotating refresh token concurrently. An account-ID change after refresh fails
closed.

### Anthropic

Each account owns a canonical isolated `CLAUDE_CONFIG_DIR`. Claude Code owns the corresponding Keychain
item and any refresh-token mutation. The manager reads the current implementation's credential payload
only through a versioned adapter, and asks the official CLI to refresh or project it into the stable
managed active profile.

The active Claude profile is a lease. A profile credential may rotate while leased, so activation and
refresh never copy a stale saved blob over the active slot.

## Switching transaction

Every provider switch follows one state machine:

```text
prepared → draining → synchronizing → activating → verifying → committed
                              │             │              │
                              └────── failure ──────────────┴──▶ rolledBack | failed
```

The provider switching lease is acquired before `prepared` and released only after a terminal journal
entry.

1. Resolve one enabled target account of the correct provider.
2. Refresh its credential and obtain a fresh usage snapshot.
3. Journal `prepared` with the next generation.
4. Drain every managed session to a request boundary.
5. Persist any rotating credential held by the active runtime back to its source profile.
6. Activate the target credential.
7. Re-fetch usage to verify live authorization.
8. Atomically commit both the `committed` journal record and provider state.
9. If anything fails after activation begins, preserve the target lease, project the source account
   again, and journal the outcome.

No normal switch interrupts a response or a running tool. A 60-second drain timeout returns
`SESSIONS_BUSY` and leaves the current account selected.

## Codex continuity

The built-in Codex provider supports Responses WebSockets. A WebSocket carries auth at its handshake and
is reused across turns, so updating auth alone does not guarantee that an existing thread changes
account.

The supervised app-server is launched with:

```toml
model_provider = "openai-http"

[model_providers.openai-http]
name = "OpenAI"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

Managed Codex TUIs connect to a manager-owned mode-`0600` Unix WebSocket gate. The native app-server
binds an ephemeral IPv4-loopback port protected by a random capability token in a mode-`0600` file.
The gate terminates the client WebSocket, forwards control traffic, queues model-dispatch RPCs during a
generation change, and tracks accepted turns until their terminal notifications. Thread start, resume,
and fork requests are forced to `openai-http`; downstream login/logout methods are rejected. The
coordinator also verifies that every loaded thread uses the managed provider and that none is active.
Threads remain loaded and their local rollout history remains intact. After active threads drain, the
manager installs external `chatgptAuthTokens`, verifies the app-server email, and lets the queued next
turn resolve the new in-process auth over HTTP. Refresh callbacks use the adapter's projected account,
not the still-uncommitted database account, so activation cannot create hybrid auth.

Existing threads created outside this provider profile are not silently adopted. They need a one-time
explicit drain and resume under the managed runtime.

## Claude continuity

Managed Claude processes all start with the same stable active `CLAUDE_CONFIG_DIR`. Each wrapper writes
a unique mode-`0600` hook settings file and restricts settings to that profile. `UserPromptSubmit` waits for any switch
barrier and marks the session working before the prompt can dispatch; `Stop`, `StopFailure`, and
`SessionEnd` drain or remove it. Background agents are also checked with `claude agents --json`. The
manager then invokes Claude's documented refresh-token login environment variables to project the target
into the active profile. Every rotating-credential copy first verifies the live upstream identity.

Arguments that disable or replace the managed hook/settings boundary (`--bare`, `--safe-mode`,
`--settings`, `--setting-sources`, `--plugin-dir`, and background-agent flags) are rejected by the
managed wrapper.

This handoff is version-gated because Claude exposes no public account-switch RPC.

## Pi continuity

Pi loads credentials into process memory and does not hot-reload an externally edited `auth.json`.
Managed Pi therefore loads a small extension that:

1. marks `turn_start` working synchronously before awaiting the active OpenAI credential;
2. cooperates at `turn_end`/`turn_start` and outer `agent_settled` boundaries;
3. closes the session's cached OpenAI Codex WebSocket;
4. overrides Pi's final `openai-codex` stream boundary so a Pi-stored OAuth token cannot win; and
5. acknowledges the generation before the next dispatch.

The access token exists only in the manager, Unix-socket response, and Pi process memory. It is never a
command-line argument.

## Usage and health

The normalized unit is `usedPercent` in the inclusive range `0..100`. The Anthropic usage endpoint's
`limits` array is the authoritative source; its `percent` values are used directly. Legacy window
objects have shipped both fractions and whole percentages, so a `utilization` at or below 1 is treated
as a fraction and anything above 1 as a percentage — an ambiguity that can only over-report a sub-1%
reading, never hide an exhausted window. Every window includes a stable ID, label, reset timestamp,
and semantic kind (`hard`, `soft`, or `spend`).

Codex usage is sampled three times and grouped by reset bucket. The majority bucket wins and its
highest utilization is retained, preventing an intermittent unrelated low-usage bucket from becoming
an automatic-rotation candidate.

Health is independent of usage:

```text
unchecked
ready
refreshDue
refreshing
loginExpiring
scopeMissing
reauthenticationRequired
temporarilyUnreachable
usageRateLimited
disabled
```

A network failure is not a login failure. An expired access token with a usable refresh token is not a
dead account. A stale snapshot is never changed to `0%` after its reset timestamp.

## Selection policy

For every fresh snapshot, define pressure as:

```text
pressure(account) = max(usedPercent of every hard window)
```

Rotation triggers when the active account's pressure is at or above the configured threshold, or the
provider reports a hard limit. Candidates must be enabled, healthy, fresh, below
`threshold - hysteresis`, and different from the active account. Sorting is:

```text
pressure ascending → account ID ascending
```

The pure selector returns a decision; it performs no I/O. The transaction coordinator decides whether
and when that decision may be enacted.

## Failure behavior

- Invalid provider JSON: fail the probe, retain the previous snapshot as visibly stale.
- 401 with refreshable auth: serialize refresh, persist the rotated token, retry once.
- Authoritative refresh rejection: mark `reauthenticationRequired`.
- Network or timeout: mark `temporarilyUnreachable`.
- Usage 429: mark `usageRateLimited` and exclude from auto-selection.
- App-server disconnect: fail the switch; never fall back to auth-file replacement.
- Busy sessions: leave the current account and journal the failure.
- Process crash during switch: startup reads the last non-terminal journal entry, preserves a known
  target credential lease, reasserts the committed source when safe, and records `rolledBack` or
  `failed` instead of guessing that the switch committed.

## Non-goals

- Switching arbitrary pre-existing processes.
- Killing sessions to force a switch.
- Sharing credentials between machines or users.
- Treating a private usage endpoint as a stable public contract.
- Circumventing a provider's entitlement, terms, or organizational controls.
- Claiming Pi has an independent account or quota pool.
