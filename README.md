# codex-auth

Keep intelligence flowing across multiple rate-limited AI subscription accounts.

Save several accounts per CLI, switch between them instantly, see every account's
5-hour-window usage in one place, and let the auto-rotator move you off an account
before it hits its limit.

Supports **Codex**, **Claude Code**, and **pi** — each has different credential
storage, login mechanics, and session behavior. This tool normalizes all of it.

## Install

```sh
npm install -g codex-auth      # or: bun add -g codex-auth
```

Requires Node 18+. macOS and Linux (Claude Code support is macOS-only today — its
credentials live in the login keychain).

## Usage

```sh
# see every account, every provider, with live usage
codex-auth status

# rotate now if the active account is past 95% of its 5h window
codex-auth rotate

# keep rotating automatically, forever
codex-auth watch
```

Per-provider account management:

```sh
codex-auth codex  add|save|use|list|current [name]
codex-auth claude add|save|use|list|current [name]
codex-auth pi          save|use|list|current [name]
```

Codex is also the default provider, so the bare commands still work:
`codex-auth save <name>`, `codex-auth use <name>`, `codex-auth switch <name>`, etc.

### Example

```
$ codex-auth status

Codex
 * work             dexter@example.com      [pro]  5h 96% resets 11:50 p.m.  weekly 11% resets 06:50 p.m.
   personal         me@example.com          [pro]  5h 12% resets 01:20 a.m.  weekly 3% resets 09:17 p.m.

Claude Code
 * primary          dexter@example.com             5h 26% resets 03:00 a.m.  weekly 5% resets 09:00 a.m.

$ codex-auth rotate
[codex] Stopping codex pid 55823...
[codex] Switched Codex auth to "personal".
[codex] Resumed 019f497e-9dd7-7a81-a484-d724c7e36658 in tmux pane %7.
[codex] rotated work (96%) → personal (12%)
```

## Commands

| Command | What it does |
|---|---|
| `status [--json]` | Live 5h + weekly usage for every saved account, across providers. Marks the active one. |
| `rotate [--provider p] [--threshold 95] [--dry-run]` | If the active account is at/above the threshold, switch to the least-used saved account. |
| `watch [--interval 120] [--threshold 95] [--providers ...]` | Run `rotate` on a loop, and repair credentials clobbered by a running session. |
| `<provider> add <name>` | Log into a **new** account without logging out of the current one. |
| `<provider> save <name>` | Snapshot the currently-live credentials under a name. |
| `<provider> use [name]` | Make a saved account live (interactive picker if no name). |
| `<provider> list` / `current` | List saved accounts / show the active one. |
| `switch <name>` (codex) | `use`, plus kill and `codex resume` your running codex sessions on the new account. |

## How each provider behaves

The three CLIs differ in ways that matter, and the tool handles each correctly.

**Codex** stores credentials in `~/.codex/auth.json`. A new account can be added
with a fully isolated login (`CODEX_HOME` pointed at a temp dir), so your running
session is never disturbed. Running sessions cache their tokens in memory and will
**not** pick up a swapped account — `rotate`/`switch` therefore kill each
user-owned session and immediately `codex resume` it, which restores the full
conversation. Sessions in tmux panes resume automatically; sessions in plain
terminals print the exact `codex resume <id>` to paste.

**Claude Code** stores credentials in the macOS login keychain (one item, shared
across config dirs — so an isolated login is impossible; `add` snapshots, logs in,
then restores). Running sessions hold their token in memory and keep working
across a swap, so **no restart is needed**. Note the keychain item also holds MCP
server tokens; those stay put and never move between accounts.

**pi** keeps its own OAuth store at `~/.pi/agent/auth.json`. Its job dispatcher has
no retry or resume: killing a running codex child marks that job **failed** and
loses the work. So rotation never touches pi's running jobs — swapping auth means
newly dispatched work uses the new account, and in-flight jobs finish on the old one.

## Safety

Both Codex and Claude Code rewrite their credentials in place when they refresh
tokens, and both rotate refresh tokens (a refresh token is single-use — reusing an
old copy invalidates the account). That creates two hazards this tool defends
against:

- **Sync-back before every switch.** The outgoing account's freshest tokens are
  copied into its snapshot first, so a rotated refresh token is never stranded.
  Snapshots are never symlinked into place, only copied, and every swap is verified
  by re-reading it afterwards.
- **Clobber repair.** A session that is still alive on the old account can refresh
  and overwrite the credentials you just swapped in. `watch` detects this (the live
  credentials no longer match the active account), attributes the stray tokens back
  to their real owner, and re-asserts the account you chose.

Accounts are identified by account **and** user id — two seats in one ChatGPT
workspace share an account id but have separate rate limits, and are never treated
as the same account.

Usage is read from each provider's own endpoint (`wham/usage` for Codex,
`/api/oauth/usage` for Claude), which costs no model tokens. Codex's endpoint
intermittently returns a stale, unrelated rate-limit bucket, so each reading is a
best-of-three consensus — a single bad sample can't rotate you onto an exhausted
account.

Credentials are stored under `~/.codex-auth/<provider>/<name>.json`, mode 0600,
written atomically. Existing `~/.codex/accounts/*.json` snapshots are migrated
automatically on first run.

## Development

```sh
npm install
npm run build
npm test          # rotation policy tests (fake providers, no network)
```

See [DESIGN.md](./DESIGN.md) for the layered architecture (store → auth + limits →
sessions → rotator) and the research behind each provider's mechanics.

## License

MIT
