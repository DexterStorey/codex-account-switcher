# tokmax

A local account, quota, and auth-injecting proxy for Codex and Claude Code.

It registers subscription accounts, keeps their credentials in the macOS Keychain, and displays every
account's current usage windows. Native Codex and Claude Code point their API traffic at a loopback
proxy that forwards each request to the real provider and injects the active account's credential.
Because the active account is read per request, switching accounts takes effect on the very next
request — including one sent mid-turn — and the clients themselves run unmodified against their real
`~/.codex` and `~/.claude`.

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

● active — every request uses it · q quit · r refresh · tokmax --help
```

## What is actually managed

There are two independent axes:

- **Provider accounts:** OpenAI and Anthropic.
- **Runtime clients:** Codex CLI and Claude Code.

tokmax never touches a running process. It changes only which credential the proxy injects, so a switch
is a local state update that the next request picks up. After `tokmax install`, plain `codex` and
`claude` route through the proxy; the wrappers do the same per launch and auto-select an account when
none is active:

```bash
tokmax codex
tokmax claude
```

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
tokmax codex relogin dexter@example.com
tokmax claude relogin dexter@example.com

tokmax list
```

Each account is named by the verified email returned after login. The optional Claude `--email`
value only pre-fills the provider login; it never overrides the verified identity.
Reauthentication pauses the manager for the swap and restarts it afterward, keeping the old credential
durable until the isolated replacement has been verified and committed.

Codex credentials are imported into this application's Keychain service and the temporary login home
is deleted. Claude credentials remain in Claude Code's own per-`CLAUDE_CONFIG_DIR` Keychain profiles
(or Claude's mode-`0600` fallback when Keychain is unavailable); those isolated profiles are used only
as credential stores, never for running sessions.
SQLite contains identities, health, usage, and opaque secret references—never tokens.

## tokmax install

```bash
tokmax install
```

`tokmax install` writes the proxy settings into your real client config so plain `codex` and `claude`
route through tokmax:

- `~/.codex/config.toml` gains a restorable managed block (delimited by `# >>> tokmax managed`) that
  adds a `tokmax` model provider whose `base_url` points at the proxy with `wire_api = "responses"`.
- `~/.claude/settings.json` gains an `env` block that sets `ANTHROPIC_BASE_URL` to the proxy and
  `ANTHROPIC_AUTH_TOKEN` to a placeholder. The real OAuth token is injected server-side by the proxy;
  the placeholder only satisfies the client's need for a value.

`tokmax uninstall` restores both files exactly. Install is optional: the `tokmax codex` and
`tokmax claude` wrappers apply the same routing per launch.

## Select an account and launch

```bash
tokmax switch codex dexter@example.com
tokmax switch claude dexter@example.com

# with config installed:
codex
claude

# or per-launch, auto-selecting an account when none is active:
tokmax codex
tokmax claude
```

Launching through a wrapper with no active account selects one automatically — healthy accounts first,
lowest usage pressure wins — and prints the choice. The clients run natively against the real
`~/.codex` and `~/.claude`, so `codex exec`, `/status`, the working directory, and subagents all behave
normally.

`tokmax switch` is near-instant (~2s, dominated by a single verification probe of the target
credential). It probes the target to confirm the credential is usable, then commits the new active
account and generation to SQLite. Because the proxy reads the active account per request, the change
applies on the very next request — including one sent mid-turn — with no drain, activation, or client
restart. On a `401` the proxy performs one reactive credential refresh and replays the request, so a
token that expires between probes never surfaces to the client.

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

The dashboard and wrappers start the local daemon when needed.

```bash
tokmax daemon start
tokmax daemon status
tokmax daemon stop
```

The daemon runs the local proxy and the periodic usage/health probes; the proxy binds only
`127.0.0.1:8459` (override with `TOKMAX_PROXY_PORT`). Its Unix control socket is mode `0600`. State
lives under `~/.codex-auth` by default (the pre-rename home is kept because Claude Keychain items are
keyed to profile paths); set `TOKMAX_HOME` to isolate an installation.

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
