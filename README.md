# codex-auth

A command-line tool that lets you manage and switch between multiple Codex accounts instantly, no more constant logins and logouts.

> [!WARNING]
> Not affiliated with OpenAI or Codex. Not an official tool.

## How it Works

Codex stores your authentication session in a single `auth.json` file. This tool works by creating named snapshots of that file for each of your accounts. When you want to switch, `codex-auth` swaps the active `~/.codex/auth.json` with the snapshot you select, instantly changing your logged-in account.

## Requirements

- Node.js 18 or newer

## Install (npm)

```sh
npm i -g codex-auth
```

## Usage

```sh
# save the current logged-in token as a named account
codex-auth save <name>

# log into ANOTHER account and save it, without logging out of the current one
codex-auth add <name>

# switch active account (for sessions started afterwards)
codex-auth use <name>

# switch AND restart running Codex sessions on the new account (kill + resume)
codex-auth switch <name>

# or pick interactively
codex-auth use

# list accounts
codex-auth list

# show current account name
codex-auth current
```

### Command reference

- `codex-auth save <name>` – Validates `<name>`, ensures `auth.json` exists, then snapshots it to `~/.codex/accounts/<name>.json`.
- `codex-auth add <name>` – Runs `codex login` with `CODEX_HOME` pointed at a temporary directory, so the browser auth flow never touches your active `~/.codex/auth.json` (useful while a Codex session is running). The resulting tokens are saved to `~/.codex/accounts/<name>.json` and the temp directory is removed.
- `codex-auth use [name]` – Accepts a name or launches an interactive selector with the current account pre-selected. Syncs the outgoing account's refreshed tokens back to its snapshot, then copies the new account into place (copies, not symlinks — Codex rewrites `auth.json` in place on token refresh, which would corrupt a symlinked snapshot). Only affects sessions started afterwards.
- `codex-auth switch <name>` – Everything `use` does, plus restarts running Codex sessions so they continue on the new account: finds each running `codex` process, maps it to its session id (via its open rollout file), kills it, switches auth, then resumes. Sessions in tmux panes are auto-resumed in place; sessions in plain terminals get a printed `codex resume <id>` to paste. Processes owned by other programs (orchestrators, the Codex desktop app) are left alone unless `--include-managed` is passed. Supports `--dry-run` and `--pid <pid>` filtering.
- `codex-auth list` – Lists all saved snapshots alphabetically and marks the active one with `*`.
- `codex-auth current` – Prints the active account name, or a friendly message if none is active.

Notes:

- Works on macOS/Linux (symlink) and Windows (copy).
- Requires Node 18+.
