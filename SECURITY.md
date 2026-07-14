# Security

## Secret storage

- OpenAI OAuth documents are stored in the macOS Keychain service
  `com.rubriclabs.tokmax` under opaque UUID references.
- Claude Code credentials remain in Claude Code's own Keychain item for each isolated
  `CLAUDE_CONFIG_DIR`. If Claude falls back to `.credentials.json`, the adapter requires no
  group/other permission bits before it will read the file.
- SQLite stores only identity, health, usage, profile paths, and opaque references.
- The manager and managed Codex client Unix sockets are mode `0600`; application directories are
  `0700`. The native app-server binds only IPv4 loopback and requires a random capability token stored
  in a mode-`0600` file.
- Tokens are never logged or passed as command-line arguments.
- Managed Pi receives only the active access token over the local socket and holds it in process memory.

Claude Code's official refresh-token handoff uses environment variables. The manager supplies them only
to the direct child process and never persists them in its journal or logs.

## Threat model

The application protects credentials from accidental plaintext files, shell history, process argument
lists, logs, and other local users. It does not defend against malware or an administrator already able
to inspect the user's processes, memory, Keychain, or home directory.

The local manager socket and Codex capability token are not remote APIs. Do not expose them through a
network bridge, shared container volume, or permissive socket proxy.

Versions before this rebuild stored account snapshots as plaintext under `~/.codex-auth/codex` and
`~/.codex-auth/claude`. `tokmax doctor` detects those directories. Re-register and verify the
accounts in the Keychain-backed store before explicitly removing the legacy snapshots.

## Provider boundaries

The direct usage endpoints and portions of credential layout are versioned compatibility surfaces.
Responses are schema-validated and failures are closed: the manager excludes unknown accounts from
automatic selection instead of assuming unused capacity.

## Reporting

Do not include `auth.json`, Keychain output, OAuth tokens, manager IPC payloads, or raw provider response
headers in an issue. Report security problems privately to the repository owner before public disclosure.
