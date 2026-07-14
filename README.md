# Codex Account Switcher

A local account, quota, and runtime control plane for Codex, Claude Code, and Pi.

It registers subscription accounts without touching live sessions, keeps credentials in the macOS
Keychain, displays every account's current usage windows, and switches managed runtimes only at a
safe request boundary.

```text
CODEX ACCOUNT SWITCHER
local control plane · 9:42:18 AM · 1 claude · 2 pi

OPENAI · Codex + Pi  AUTO ON · 95% threshold  auth generation 4
  ● dexter@example.com
     5h [███████████████░]  94%  7d [██████░░░░░░░░░░]  38%
     ready                        resets 38m
  ○ zero@example.com
     5h [██░░░░░░░░░░░░░░]  12%  7d [████░░░░░░░░░░░░]  24%
     ready                        resets 3h 12m

ANTHROPIC · Claude Code  AUTO OFF  auth generation 1
  ● dexter2@example.com
     5h [████░░░░░░░░░░░░]  27%  7d [█░░░░░░░░░░░░░░░]   5%
     ready                        resets 2h 5m
```

## What is actually managed

There are two independent axes:

- **Provider accounts:** OpenAI and Anthropic.
- **Runtime clients:** Codex CLI, Claude Code, and Pi.

Pi is a client, not a third subscription provider. Pi's `openai-codex` traffic consumes the selected
OpenAI account's Codex allowance. Pi's Anthropic OAuth usage is currently treated as extra usage by
Pi, not as Claude Max plan usage, so this project does not pretend that rotating Max accounts extends
Pi-to-Anthropic runtime.

The manager intentionally controls only processes launched through its wrappers:

```bash
codex-auth codex
codex-auth claude
codex-auth pi --model openai-codex/gpt-5.4
```

Existing unmanaged processes stay outside the control plane. They are never killed or rewritten.

## Requirements

- macOS (the initial vault implementation uses Keychain)
- [Bun](https://bun.sh/) 1.2 or newer
- Codex CLI, Claude Code, and/or Pi on `PATH`

The compatibility suite was developed against Codex `0.144.1`, Claude Code `2.1.206`, and Pi `0.80.6`.
See [COMPATIBILITY.md](./COMPATIBILITY.md) before upgrading those clients.

## Install

```bash
git clone https://github.com/DexterStorey/codex-account-switcher.git
cd codex-account-switcher
bun install
bun run check
bun link
```

Run `codex-auth doctor` to verify the local tools and manager boundary.

## Register accounts

Each login runs in its own isolated provider home. It does not change the account used by a currently
running process.

```bash
codex-auth account add codex
codex-auth account add codex

codex-auth account add claude --email dexter@example.com
codex-auth account add claude

# Repair an expired/revoked login without changing its stable account ID.
codex-auth daemon stop
codex-auth account reauthenticate codex dexter@example.com
codex-auth account reauthenticate claude dexter@example.com

codex-auth account list
```

Each account is named by the verified email returned after login. The optional Claude `--email`
value only pre-fills the provider login; it never overrides the verified identity.
Reauthentication intentionally requires a stopped manager and no live managed sessions. This keeps
the old credential durable until the isolated replacement has been verified and committed.

Codex credentials are imported into this application's Keychain service and the temporary login home
is deleted. Claude credentials remain in Claude Code's own per-`CLAUDE_CONFIG_DIR` Keychain profiles
(or Claude's mode-`0600` fallback when Keychain is unavailable).
SQLite contains identities, health, usage, and opaque secret references—never tokens.

## Select an account and launch managed clients

```bash
codex-auth switch codex dexter@example.com
codex-auth switch claude dexter@example.com

codex-auth codex
codex-auth claude
codex-auth pi --model openai-codex/gpt-5.4
```

Switching is transactional:

1. Refresh and validate the target credential.
2. Wait for managed sessions to reach an idle boundary.
3. Activate the target in the provider runtime.
4. Verify identity and rate limits.
5. Commit the new generation to SQLite.
6. Roll back to the prior account if activation or verification fails.

Codex threads stay loaded in a dedicated app-server. The managed provider forces HTTP Responses
transport so the next turn reads the new auth generation; Codex's default WebSocket transport binds
auth at the handshake and cannot safely hot-switch. A local dispatch gate queues newly submitted Codex
turns, tracks accepted dispatch RPCs, and requires stable idle samples before activation. Claude Code
sessions use one managed active `CLAUDE_CONFIG_DIR`; wrapper-owned `UserPromptSubmit`, `Stop`, and
session hooks form the cooperative request boundary. Pi marks a turn working before credential lookup,
then updates the process-local provider credential and closes its cached Codex WebSocket before dispatch.

## Dashboard and automation

Run the live dashboard:

```bash
codex-auth
```

Or get machine-readable state:

```bash
codex-auth status --json
codex-auth refresh
```

Automatic rotation is disabled by default. Enabling it requires an explicit confirmation that your
provider permits this use of the accounts:

```bash
codex-auth auto codex on --threshold 95 --authorized
codex-auth auto claude on --threshold 95 --authorized
codex-auth auto both on --threshold 95 --authorized

codex-auth auto codex off
codex-auth auto claude off
```

The selector is pure and deterministic. It:

- triggers when the active account reaches the threshold in **any** hard window;
- refuses stale, missing, rate-limited, disabled, or unhealthy candidates;
- ranks candidates by their worst hard-window pressure, lowest first;
- applies hysteresis and minimum dwell time to prevent oscillation; and
- uses account ID as the stable final tie-breaker.

A failed or expired reading is `unknown`, never `0%`.

## Daemon commands

The dashboard and managed wrappers start the local daemon when needed.

```bash
codex-auth daemon start
codex-auth daemon status
codex-auth daemon stop
```

The daemon owns the switching leases, provider probes, and Codex app-server connection. Manager and
managed-client Unix sockets are mode `0600`. The app-server's private loopback listener requires a
random capability token held in a mode-`0600` file. State lives under `~/.codex-auth` by default; set
`CODEX_AUTH_HOME` to isolate an installation.

## Why this does not swap auth files

Codex caches credentials in process, rotates refresh tokens, and can keep an authenticated WebSocket
across turns. Replacing `~/.codex/auth.json` underneath running processes can strand refresh tokens or
appear to switch while requests continue on the old account. OpenAI documents that Codex caches login
details in `auth.json` or the OS credential store and refreshes ChatGPT tokens during use.
[Authentication documentation](https://learn.chatgpt.com/docs/auth#login-caching)

The managed Codex runtime instead uses:

- a dedicated app-server on an authenticated IPv4-loopback endpoint;
- a mode-`0600` Unix WebSocket gate for managed Codex TUIs;
- a manager-owned dispatch gate that pauses new turns during a switch;
- external `chatgptAuthTokens` login;
- a custom provider with `requires_openai_auth = true`; and
- `supports_websockets = false`, making the next idle turn the auth boundary.

OpenAI documents custom providers and `requires_openai_auth` in the
[Codex authentication guide](https://learn.chatgpt.com/docs/auth#alternative-model-providers).
The app-server account methods are experimental, so they remain isolated behind a compatibility adapter.

## Rate-limit sources

- **Codex:** five-hour, weekly, and additional metered windows from the same backend model used by the
  Codex client. Official Codex pricing confirms a shared five-hour window and that additional weekly
  limits may apply. [Codex pricing](https://learn.chatgpt.com/docs/pricing#usage-limits)
- **Claude Code:** five-hour, seven-day, and available model/surface windows from the authenticated
  usage response.
- **Pi:** no separate quota. OpenAI usage is attributed to the selected OpenAI account; Anthropic OAuth
  spend is not presented as Claude Max utilization.

The direct Codex and Claude usage endpoints are compatibility surfaces, not public APIs. Probes are
strictly parsed, conservatively cached, and fail closed. They may require adapter updates when a provider
changes its client.

## Provider authorization

This is a local orchestration tool, not a way to obtain additional entitlement. Use only accounts you
own or administer and only where the relevant agreement permits account automation.

Anthropic currently says Claude.ai OAuth is intended for Anthropic applications and restricts third
parties from routing subscription credentials without approval.
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) ·
[Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)

For that reason, the project ships monitoring and manual switching normally, but requires
`--authorized` before automatic rotation can be enabled. That flag records your confirmation; it is not
legal advice or provider approval.

## Development

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

The codebase is TypeScript + Zod 4, Bun SQLite, and Biome. There is no CLI framework and no implicit
global state: schemas own boundaries, SQLite owns durable transitions, provider adapters own unstable
integration details, and the selection engine is a pure function.

See [DESIGN.md](./DESIGN.md), [SECURITY.md](./SECURITY.md), and
[COMPATIBILITY.md](./COMPATIBILITY.md) for the detailed contracts.

## License

MIT
