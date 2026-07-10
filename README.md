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

# switch active account (symlinks on macOS/Linux; copies on Windows)
codex-auth use <name>

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
- `codex-auth use [name]` – Accepts a name or launches an interactive selector with the current account pre-selected. Copies on Windows, creates a symlink elsewhere, and records the active name.
- `codex-auth list` – Lists all saved snapshots alphabetically and marks the active one with `*`.
- `codex-auth current` – Prints the active account name, or a friendly message if none is active.

Notes:

- Works on macOS/Linux (symlink) and Windows (copy).
- Requires Node 18+.
