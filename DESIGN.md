# Design

## System model

The application models provider accounts separately from runtime clients:

```text
Provider accounts                      Runtime clients
┌─────────────────────┐                ┌─────────────────────┐
│ OpenAI              │───────────────▶│ Codex CLI           │
│  account A, B, C    │                └─────────────────────┘
└─────────────────────┘

┌─────────────────────┐                ┌─────────────────────┐
│ Anthropic           │───────────────▶│ Claude Code         │
│  account D, E, F, G │                └─────────────────────┘
└─────────────────────┘
```

## Boundaries

| Boundary | Responsibility | Durable data |
| --- | --- | --- |
| `domain.ts` | Canonical Zod schemas and inferred types | None |
| `storage.ts` | SQLite migrations, validated persistence, atomic commits | Metadata only |
| `proxy.ts` | Loopback HTTP proxy: route by provider, forward upstream, inject auth, replay once on 401 | None |
| `runtime-source.ts` | Resolve the active account into an upstream + injected headers; refresh on demand | None |
| `config-install.ts` | Write and restore the managed blocks in `~/.codex` and `~/.claude` | Client config |
| `providers/codex` | Login, vault, OAuth refresh, usage probe | Keychain secret |
| `providers/claude` | Profile login, credential compatibility, usage probe | Claude Keychain profile |
| `selection.ts` | Pure deterministic rotation decision | None |
| `manager.ts` | Proxy lifecycle, probe scheduling, switch commit | Via storage |
| `ipc.ts` | Strict local request boundary | Unix socket only |
| `ui.ts` | Read-only terminal projection | None |
| `cli.ts` | Command parsing and composition | None |

The provider adapters are now probe-only: they read usage and health, and no longer activate or drain a
runtime. Provider-specific response shapes never cross into application code. Each adapter validates its
input and emits an `Account`, `UsageSnapshot`, or explicit application error.

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

The daemon is the only refresh owner. Refreshes are serialized per Keychain reference so no two callers
— a probe and a proxy request, or two probes — can submit the same rotating refresh token concurrently.
An account-ID change after refresh fails closed.

### Anthropic

Each account owns a canonical isolated `CLAUDE_CONFIG_DIR` under `~/.codex-auth/profiles/claude`, used
only as a credential store and never for a running session. Claude Code owns the corresponding Keychain
item and its credential format. The proxy and the probes read that profile's credential through a
versioned adapter and, when it is near expiry or rejected, refresh it in place; the rotated token is
written straight back to the same profile. There is no separate active-profile slot to keep in sync.

## Switching

A switch is a validated state update, not a runtime handoff. The proxy reads the active account per
request, so pointing every subsequent request at the target is all a switch has to do.

1. Resolve the target: it must be an enabled account of the requested provider.
2. If it is not already active, probe it once — read the credential, refresh if stale, and verify live
   authorization — so a switch never commits to an unusable account.
3. Atomically commit the `committed` switch record together with the new provider state (active account
   plus the next generation) to SQLite.

The commit is serialized per provider behind the same operation queue as the probes, so a switch and an
in-flight probe cannot interleave. There is no drain, activation, rollback, or lease: the previous
account simply stops being injected once the store is updated, and the change is visible on the very
next request — including one sent mid-turn. A switch is near-instant (~2s, dominated by the single
verification probe).

## Runtime credential injection

The native clients run unmodified; only their API base URL is redirected at tokmax. A local HTTP proxy
listens on `127.0.0.1:8459` (configurable via `TOKMAX_PROXY_PORT`) and exposes one path prefix per
provider — `/openai` and `/anthropic`. For each request it:

1. Reads the provider's active account from the store — per request, so the newest committed generation
   always wins, even for a request sent mid-turn.
2. Forwards the request to the real upstream: `/openai` to `https://chatgpt.com/backend-api/codex`,
   `/anthropic` to `https://api.anthropic.com`.
3. Injects the active account's credential. For OpenAI it sets `Authorization: Bearer <access token>`
   and `chatgpt-account-id`. For Anthropic it sets `Authorization: Bearer <OAuth access token>`, appends
   `anthropic-beta: oauth-2025-04-20` to the client's own betas, and strips any `x-api-key` so the
   injected bearer wins.
4. On a `401` — a token that expired between refresh cycles — it refreshes the active credential once
   and replays the identical request, so the client never sees the transient failure.

`config-install.ts` wires the clients to the proxy by editing their real config inside restorable
managed blocks. Codex gets a `tokmax` model provider in `~/.codex/config.toml` (`base_url` at `/openai`,
`wire_api = "responses"`); Claude Code gets `ANTHROPIC_BASE_URL` and a placeholder `ANTHROPIC_AUTH_TOKEN`
in `~/.claude/settings.json`. `tokmax uninstall` restores both. The `tokmax codex` and `tokmax claude`
wrappers pass the same settings per launch, so they work whether or not the config is installed.

Because there is no app-server, no isolated running profile, no hooks, and no settings mirroring, the
clients behave exactly as they do natively: `codex exec`, `/status`, the working directory, and
subagents all work.

The credential source (`runtime-source.ts`) reuses the same vault, profile reader, and refresh paths the
probes use, so each credential still has exactly one refresh owner. A token near expiry is refreshed
proactively before injection; a rejected one triggers the single reactive refresh above.

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

The pure selector returns a decision; it performs no I/O. The manager decides whether and when that
decision is enacted as a switch commit.

## Failure behavior

- Invalid provider JSON: fail the probe, retain the previous snapshot as visibly stale.
- 401 with refreshable auth: serialize refresh, persist the rotated token, retry once — on the probe
  path and, for a live client request, once inside the proxy before replaying.
- Authoritative refresh rejection: mark `reauthenticationRequired`.
- Network or timeout: mark `temporarilyUnreachable`.
- Usage 429: mark `usageRateLimited` and exclude from auto-selection.
- Target probe fails during a switch: refuse the switch, leave the current account active, and surface
  the error; nothing is committed.
- No active account or unreachable upstream: the proxy returns an explicit `503` or `502` to the client
  rather than silently sending the request on the wrong account.
- Process crash: a switch is a single atomic commit, so startup finds either the prior or the new active
  account — never a half-applied handoff to reconcile.

## Non-goals

- Switching arbitrary pre-existing processes.
- Killing sessions to force a switch.
- Sharing credentials between machines or users.
- Treating a private usage endpoint as a stable public contract.
- Circumventing a provider's entitlement, terms, or organizational controls.
