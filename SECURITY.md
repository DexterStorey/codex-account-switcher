# Security

## Secret storage

- OpenAI OAuth documents are stored in the macOS Keychain service `com.rubriclabs.tokmax`, split across
  chunked items under opaque UUID references.
- Claude Code credentials remain in Claude Code's own Keychain item for each isolated
  `CLAUDE_CONFIG_DIR`, which tokmax uses only as a credential store. If Claude falls back to
  `.credentials.json`, the adapter requires no group/other permission bits before it will read the file.
- SQLite stores only identity, health, usage, profile paths, and opaque references — never an access or
  refresh token.
- The proxy injects each request's credential server-side, so tokens never reach the client config. The
  `ANTHROPIC_AUTH_TOKEN` written into `~/.claude/settings.json` is a fixed dummy placeholder; the real
  OAuth bearer is added by the proxy. The Codex managed block in `~/.codex/config.toml` and the Claude
  `env` block are delimited, restorable edits that `tokmax uninstall` reverts exactly.
- The proxy binds `127.0.0.1` only; the manager's Unix control socket is mode `0600` and application
  directories are `0700`.
- Tokens are never logged or passed as command-line arguments.

Claude Code's official refresh-token handoff uses environment variables. The manager supplies them only
to the direct child process and never persists them in its journal or logs.

## Threat model

The application protects credentials from accidental plaintext files, shell history, process argument
lists, logs, and other local users. It does not defend against malware or an administrator already able
to inspect the user's processes, memory, Keychain, or home directory.

The local manager socket and the credential-injecting proxy are local-only, not remote APIs. Any
process that can reach `127.0.0.1:8459` can have a request forwarded with the active account's
credential, so do not expose the proxy or the manager socket through a network bridge, shared container
volume, or permissive socket proxy.

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
