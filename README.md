<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/logo-light.svg">
  <img alt="tokmax — a rate-limit control plane for Codex and Claude Code, by Rubric Labs" src="assets/brand/logo-dark.svg" width="460">
</picture>

<br/>
<br/>

**Juggle rate limits across all your Codex and Claude Code accounts.**
One loopback proxy injects the right account per request — so switching takes effect
on the very next request, even mid-turn, with the native clients running unmodified.

<sub>macOS · [Bun](https://bun.sh) 1.2+ · MIT · a [Rubric Labs](https://rubriclabs.com) project</sub>

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/generated/flagship-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/generated/flagship-light.png">
  <img alt="tokmax dashboard beside live Claude Code and Codex sessions" src="assets/generated/flagship-dark.png">
</picture>

</div>

## What it is

You have more than one ChatGPT/Codex and Claude subscription, and you keep hitting the
five-hour or weekly limit on whichever account you happen to be using. `tokmax` watches
every account's usage and moves your traffic to whichever one still has headroom.

It manages two independent axes:

- **Provider accounts** — your OpenAI and Anthropic subscriptions.
- **Runtime clients** — the Codex CLI and Claude Code.

After `tokmax install`, plain `codex` and `claude` route their API traffic through a
loopback proxy on `127.0.0.1:8459`. The proxy reads the **active account per request** and
injects that account's credential, so a switch is just a local state update the next
request picks up — no drain, no restart, no touching a running process. Credentials live in
the macOS Keychain; SQLite holds only identities, health, usage, and opaque secret
references — never tokens.

## The dashboard

Run `tokmax` for a live dashboard of every account and its rate-limit windows. Each window
is colored by pressure — green with headroom, amber getting full, red near the limit.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/generated/accounts-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/generated/accounts-light.png">
  <img alt="tokmax accounts view" src="assets/generated/accounts-dark.png" width="820">
</picture>

Press **space** on any account to expand it — plan tier, every window's reset countdown,
and the account's identity — without leaving the list.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/generated/expanded-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/generated/expanded-light.png">
  <img alt="expanded account detail" src="assets/generated/expanded-dark.png" width="820">
</picture>

## Automatic rotation

Turn on auto-rotation and tokmax moves off an account the moment its fullest hard window
crosses your threshold, onto the eligible account with the most headroom — mid-turn, on the
next request.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/generated/switch-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="assets/generated/switch-light.gif">
  <img alt="an at-limit account rotating to a fresh one" src="assets/generated/switch-dark.gif" width="760">
</picture>
</div>

```bash
tokmax auto codex on --threshold 95
tokmax auto claude on --threshold 95
tokmax auto both on --threshold 95     # or: off
```

The selector is a pure, deterministic function. It:

- triggers when the active account reaches the threshold in **any** hard window;
- refuses stale, missing, rate-limited, disabled, or unhealthy candidates;
- ranks candidates by their worst hard-window pressure, lowest first;
- applies hysteresis and a minimum dwell time (holds an account ≥ 5 min) to prevent
  oscillation; and
- uses account ID as the stable final tie-breaker.

A failed or expired reading is `unknown`, never `0%`. Automatic rotation is **off by
default** — enabling it from the CLI is itself your confirmation that your provider permits
this use of the accounts (see [Provider authorization](#provider-authorization)).

## Analytics

The Analytics tab charts each provider's usage over time — 1h / 5h / 24h / 7d / 31d — so you
can see the shape of your consumption, not just a single bar.

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/generated/timelapse-dark.gif">
  <source media="(prefers-color-scheme: light)" srcset="assets/generated/timelapse-light.gif">
  <img alt="usage charting over 24 hours" src="assets/generated/timelapse-dark.gif" width="820">
</picture>
</div>

## Install

```bash
git clone https://github.com/DexterStorey/codex-account-switcher.git
cd codex-account-switcher
bun install
bun run check
bun link
```

Run `tokmax doctor` to verify the local tools and the manager boundary.

## Quickstart

```bash
# 1. Sign in to each account (isolated login homes; existing sessions untouched)
tokmax login codex
tokmax login claude

# 2. Route native codex & claude through tokmax (restorable; undo with uninstall)
tokmax install

# 3. Use the clients exactly as before — tokmax injects the active account
codex
claude

# 4. Switch accounts any time; the next request (even mid-turn) uses the new one
tokmax switch codex dexter@example.com
```

Each account is named by the verified email returned after login. Re-running `tokmax login`
repairs an expired login in place without changing the account's stable ID.

## Commands

| Command | What it does |
|---|---|
| `tokmax` · `tokmax dashboard` | Live dashboard (text render when piped) |
| `tokmax login <codex\|claude>` | Sign in to a provider; idempotent, re-auths in place |
| `tokmax install` · `uninstall` | Route native clients through the proxy · restore config |
| `tokmax list` | Accounts, health, and the active marker |
| `tokmax switch <codex\|claude> <email-or-id>` | Make an account active (~2s) |
| `tokmax auto <codex\|claude\|both> <on\|off> [--threshold N]` | Configure auto-rotation (default 95) |
| `tokmax status` · `refresh` | Machine-readable snapshot · re-probe usage now |
| `tokmax doctor` | Check tools, proxy, config, and legacy state |
| `tokmax daemon <start\|stop\|status>` | Manage the local daemon (usually automatic) |

`codex` and `openai` are interchangeable, as are `claude` and `anthropic`.

## How switching works

`tokmax switch` probes the target credential to confirm it is usable, then commits the new
active account and bumps a generation counter in SQLite. Because the proxy reads the active
account per request, the change applies on the **very next request** — including one sent
mid-turn — with no drain, activation, or client restart. On a `401` the proxy performs one
reactive credential refresh and replays the request, so a token that expires between probes
never surfaces to the client.

`tokmax install` writes restorable managed blocks into your real client config:

- `~/.codex/config.toml` gains a `tokmax` model provider whose `base_url` points at the
  proxy (`wire_api = "responses"`), delimited by `# >>> tokmax managed`.
- `~/.claude/settings.json` gains an `env` block setting `ANTHROPIC_BASE_URL` to the proxy
  and `ANTHROPIC_AUTH_TOKEN` to a placeholder. The real OAuth token is injected server-side;
  the placeholder only satisfies the client's need for a value.

`tokmax uninstall` restores both files exactly.

## Rate-limit sources

- **Codex** — five-hour, weekly, and additional metered windows from the same backend the
  Codex client uses. ([Codex pricing](https://learn.chatgpt.com/docs/pricing#usage-limits))
- **Claude Code** — five-hour, seven-day, and per-model/surface windows (e.g. `7 day · Fable`)
  from the authenticated usage response.

Only **hard** windows drive rotation pressure. Plan tiers (`Pro`, `Max`, `Max 20×`) are read
from the provider. These usage endpoints are compatibility surfaces, not public APIs; probes
are strictly parsed, conservatively cached, and fail closed.

## Configuration

| Variable | Purpose |
|---|---|
| `TOKMAX_HOME` | Relocate/isolate state (default `~/.codex-auth`) |
| `TOKMAX_PROXY_PORT` | Override the proxy port (default `8459`, loopback only) |
| `TOKMAX_THEME` | Force `light` or `dark` (else auto-detected) |

The daemon runs the proxy and periodic usage/health probes; its Unix control socket is mode
`0600`. State lives under `~/.codex-auth` by default — the pre-rename path is kept
deliberately, because Claude Keychain items are keyed to profile paths.

## Provider authorization

This is a local orchestration tool, not a way to obtain additional entitlement. Use only
accounts you own or administer, and only where the relevant agreement permits account
automation. Anthropic currently says Claude.ai OAuth is intended for Anthropic applications
and restricts third parties from routing subscription credentials without approval.
([Claude Code legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) ·
[Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms))

For that reason the project ships monitoring and manual switching normally, and automatic
rotation is off by default. Enabling it from the CLI records your confirmation; it is not
legal advice or provider approval.

## Development

```bash
bun run check     # typecheck + lint + test
bun run build     # bundle to dist/
bun run assets    # regenerate every screenshot + flagship (see assets/README.md)
```

TypeScript + Zod 4, Bun SQLite, and Biome. No CLI framework and no hidden global state:
schemas own boundaries, SQLite owns durable transitions, provider adapters own unstable
integration details, and the selection engine is a pure function. See
[DESIGN.md](./DESIGN.md), [SECURITY.md](./SECURITY.md), and
[COMPATIBILITY.md](./COMPATIBILITY.md) for the detailed contracts.

Every image in this README is generated from source — the real TUI rendered against
synthetic fixtures with a pinned clock — so it regenerates deterministically. See
[`assets/`](./assets/README.md) and [`remotion/`](./remotion).

## License

MIT — © Rubric Labs contributors. Built by [Rubric Labs](https://rubriclabs.com).
