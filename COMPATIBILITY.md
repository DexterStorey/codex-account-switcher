# Compatibility

tokmax runs the native clients unchanged and routes their API traffic through a local proxy that
injects the active account's credential. It touches a few surfaces that are experimental or not public
APIs; compatibility is explicit and conservative.

| Client | Developed against | Stable surface | Versioned compatibility surface |
| --- | ---: | --- | --- |
| Codex CLI | 0.144.1 | `codex login`, `model_provider`/`base_url`/`wire_api` config | ChatGPT plan backend endpoint and its usage payload; OAuth refresh + `chatgpt-account-id` header |
| Claude Code | 2.1.206 | `claude auth login --claudeai`, `ANTHROPIC_BASE_URL` gateway env | per-profile Keychain service derivation, credential fields, refresh-token env handoff, OAuth `/api/oauth/usage` payload |

## Upgrade checklist

Before updating a native client:

1. Run `bun run check`.
2. Run `tokmax doctor`.
3. Register a disposable test account with `tokmax login codex` (or `tokmax login claude`) in an isolated `TOKMAX_HOME`.
4. Confirm its identity and all usage windows.
5. `tokmax install`, then run the native client and switch the active account twice.
6. Confirm the next request uses the newly selected account (the proxy injects per request).
7. Confirm an expired access token triggers one refresh-and-replay and the old refresh token is never reused.
8. Confirm the dashboard marks malformed or rate-limited usage as unknown, never `0%`.
9. `tokmax uninstall` and confirm the original client config is restored exactly.

## Codex invariants

- `tokmax install` writes a `model_provider = "tokmax"` provider with `base_url` at the proxy and
  `wire_api = "responses"`, inside a restorable managed block; it must never rewrite the user's own
  auth or provider defaults outside that block.
- The proxy injects `Authorization: Bearer <access token>` and `chatgpt-account-id`; the ChatGPT plan
  backend (`chatgpt.com/backend-api/codex`) and its usage payload are unstable surfaces, strictly
  parsed and fail-closed.
- Refresh goes to `auth.openai.com`; an account-id change after refresh must fail closed.

## Claude invariants

- Each account's isolated `CLAUDE_CONFIG_DIR` profile must resolve to a distinct Keychain service; the
  profiles are credential stores only, never the directory a session runs in.
- Refresh reuses `claude auth login --claudeai` with the refresh-token env vars (no `logout`, which
  revokes credentials); the credential is read only through a versioned adapter.
- `tokmax install` sets `ANTHROPIC_BASE_URL` and a placeholder `ANTHROPIC_AUTH_TOKEN`; the proxy strips
  any `x-api-key`, injects the real subscription bearer, and appends `anthropic-beta: oauth-2025-04-20`.
- `/api/oauth/usage` reports the authoritative readings in its `limits` array as whole percentages;
  legacy fraction-vs-percentage ambiguity is normalized, and an out-of-range value fails parsing.

If any invariant fails, disable switching for that integration until its adapter and tests are updated.
