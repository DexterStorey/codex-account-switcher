# tokmax

A local account, quota, and runtime control plane for Codex and Claude Code.

It registers subscription accounts without touching live sessions, keeps credentials in the macOS
Keychain, displays every account's current usage windows, and switches managed runtimes only at a
safe request boundary.

```text
tokmax · 9:42 AM · 2 codex · 1 claude

OpenAI · Codex                             auto-rotate on @95% · gen 4
  ● dexter@example.com                         active
      5 hour               ███████████████░   94% · resets 38m
      7 day                ██████░░░░░░░░░░   38% · resets 4d 6h
  ○ zero@example.com
      5 hour               ██░░░░░░░░░░░░░░   12% · resets 3h 12m
      7 day                ████░░░░░░░░░░░░   24% · resets 5d 1h

Anthropic · Claude Code                    auto-rotate off · gen 1
  ● dexter2@example.com                        active
      5h session           ████░░░░░░░░░░░░   27% · resets 2h 5m
      7 day · all models   █░░░░░░░░░░░░░░░    5% · resets 6d 18h
```

## What is actually managed

There are two independent axes:

- **Provider accounts:** OpenAI and Anthropic.
- **Runtime clients:** Codex CLI and Claude Code.

The manager intentionally controls only processes launched through its wrappers:

```bash
tokmax codex
tokmax claude
```

Existing unmanaged processes stay outside the control plane. They are never killed or rewritten.

## Requirements

- macOS (the initial vault implementation uses Keychain)
- [Bun](https://bun.sh/) 1.2 or newer
- Codex CLI and/or Claude Code on `PATH`

The compatibility suite was developed against Codex `0.144.1` and Claude Code `2.1.206`.
See [COMPATIBILITY.md](./COMPATIBILITY.md) before upgrading those clients.

## Install

```bash
git clone https://github.com/DexterStorey/codex-account-switcher.git
cd codex-account-switcher
bun install
bun run check
bun link
```

Run `tokmax doctor` to verify the local tools and manager boundary.

## Register accounts

Each login runs in its own isolated provider home. It does not change the account used by a currently
running process.

```bash
tokmax codex login
tokmax codex login

tokmax claude login --email dexter@example.com
tokmax claude login

# Repair an expired/revoked login without changing its stable account ID.
tokmax daemon stop
tokmax codex relogin dexter@example.com
tokmax claude relogin dexter@example.com

tokmax list
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
tokmax switch codex dexter@example.com
tokmax switch claude dexter@example.com

tokmax codex
tokmax claude
```

Launching a managed client with no active account selects one automatically —
healthy accounts first, lowest usage pressure wins — and prints the choice.
Managed Claude sessions inherit your own `~/.claude` configuration (settings,
skills, agents, memory, project history) through symlinks in the managed
profile; credentials and OAuth identity metadata never cross profiles. A
switch drains managed sessions for up to 60 seconds and refuses rather than
interrupting a running turn; if the manager daemon is unreachable, managed
sessions keep working without the switch boundary instead of blocking prompts.

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
session hooks form the cooperative request boundary.

## Dashboard and automation

Run the live dashboard:

```bash
tokmax
```

Or get machine-readable state:

```bash
tokmax status --json
tokmax refresh
```

Automatic rotation is disabled by default. Enabling it requires an explicit confirmation that your
provider permits this use of the accounts:

```bash
tokmax auto codex on --threshold 95 --authorized
tokmax auto claude on --threshold 95 --authorized
tokmax auto both on --threshold 95 --authorized

tokmax auto codex off
tokmax auto claude off
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
tokmax daemon start
tokmax daemon status
tokmax daemon stop
```

The daemon owns the switching leases, provider probes, and Codex app-server connection. Manager and
managed-client Unix sockets are mode `0600`. The app-server's private loopback listener requires a
random capability token held in a mode-`0600` file. State lives under `~/.codex-auth` by default (the pre-rename home is kept because Claude Keychain items are keyed to profile paths); set
`TOKMAX_HOME` to isolate an installation.

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
