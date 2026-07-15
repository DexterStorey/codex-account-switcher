# Compatibility

The manager integrates with native coding clients, including a few surfaces that are experimental or
not public APIs. Compatibility is explicit and conservative.

| Client | Developed against | Stable surface | Versioned compatibility surface |
| --- | ---: | --- | --- |
| Codex CLI | 0.144.1 | `CODEX_HOME`, login, custom provider config, remote Unix connection | app-server WebSocket/account/thread RPC, direct usage payload |
| Claude Code | 2.1.206 | `CLAUDE_CONFIG_DIR`, auth commands, command hooks, `agents --json` | Keychain service derivation, credential fields, direct OAuth usage payload, refresh-token handoff behavior |

## Upgrade checklist

Before updating a native client:

1. Run `bun run check`.
2. Run `tokmax doctor`.
3. Register a disposable test profile in an isolated `TOKMAX_HOME`.
4. Confirm its identity and all usage windows.
5. Start one managed idle session and switch generations twice.
6. Confirm the session's next request uses the selected upstream account.
7. Confirm an expired access token rotates once and the old refresh token is never reused.
8. Confirm the dashboard marks malformed or rate-limited usage as unknown.

## Codex invariants

- The managed provider must report Responses WebSocket support disabled.
- External auth installation must not write the user's normal `~/.codex/auth.json`.
- The app-server client must answer `account/chatgptAuthTokens/refresh` within its deadline.
- Every loaded thread must use `openai-http`, and no accepted turn may remain before a generation changes.
- The loopback app-server listener must require the manager's capability token.
- The dispatch gate must have no accepted-but-unobserved turn before activation.

## Claude invariants

- Two canonical `CLAUDE_CONFIG_DIR` paths must resolve to distinct Keychain services.
- `claude auth status --json` must remain local and machine-readable.
- The active profile must adopt a refreshed target without `logout` (logout revokes credentials).
- Every managed foreground session must acknowledge the wrapper-owned turn-boundary hooks.
- `/api/oauth/usage` utilization remains a fraction in `0..1`; a value outside that range must fail parsing.

If any invariant fails, disable switching for that integration until its adapter and tests are updated.
