# Design: multi-provider account rotation

**Goal:** keep intelligence flowing across multiple rate-limited subscription accounts
(e.g. 3 Claude Code Max + 3 Codex Max). When the active account approaches its 5-hour
window limit, rotate to the least-used saved account — with the right session-continuity
mechanics per CLI.

## Architecture (modular, bottom-up)

Each layer is a standalone, independently useful API. Higher layers consume only the
public interfaces of lower layers. CLI commands are thin bindings.

```
Layer 3  rotator/    policy: threshold → pick least-used → orchestrate switch
Layer 2  sessions/   continuity mechanics: discover/kill/resume running sessions
Layer 1a auth/       per-provider credential wrappers (login/save/activate/current)
Layer 1b limits/     per-provider usage wrappers (normalized 5h/weekly windows)
Layer 0  store/      snapshot storage, atomic writes, active-account state
```

## Research findings that drive the design

(Verified live on this machine, 2026-07-09; sources: codex-rs source, Claude Code
2.1.206 bundle strings, pi async-cli-dispatch extension source.)

| | Codex | Claude Code | pi |
|---|---|---|---|
| Token store | `~/.codex/auth.json` (file) | macOS Keychain item `Claude Code-credentials`, account=`$USER` (fixed — not per config dir) | `~/.pi/agent/auth.json` (file; holds `openai-codex` + `anthropic` entries) |
| Isolated login (add w/o logout) | `CODEX_HOME=<tmp> codex login` ✅ | ❌ keychain item is global → add = snapshot → login (overwrites) → snapshot new → restore | pi login flow writes its own file; snapshot/restore around it |
| Live usage API (zero tokens) | `GET chatgpt.com/backend-api/wham/usage`, `Authorization: Bearer <tokens.access_token>`, `ChatGPT-Account-Id: <account_id>` → `primary_window`/`secondary_window` `{used_percent, reset_at, limit_window_seconds}`, plus `email`, `plan_type` | `GET api.anthropic.com/api/oauth/usage`, `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20` → `five_hour`/`seven_day` `{utilization, resets_at}`. **`utilization` is already a percent** (26 = 26%) despite the CLI bundle's `*100` mapper — verified live | read both entries with the respective endpoint above |
| Mid-session credential swap | ignored by running session (in-memory cache; 401-recovery reloads only if account id matches) | ignored by running session (in-memory token cache) — sessions keep working, **no restart needed** | same (in-memory) |
| Refresh write-back hazard | rewrites auth.json in place → clobbers a swapped file | rewrites keychain item → clobbers a swapped blob | rewrites its auth.json |
| Refresh tokens | rotating/single-use | rotating/single-use | rotating/single-use |
| Session continuity on switch | kill + `codex resume <uuid>` (rollouts are local; sessions resumable) | none needed (stateful in-memory token; new requests fine) | **never kill children**: dispatcher has no retry/resume — killed child = job failed, work lost. New dispatches pick up new auth automatically |
| Account attribution | usage response includes `email` | `/api/oauth/profile` (+ `~/.claude.json` `oauthAccount`) | per entry |

Consequences baked into the design:

1. **Sync-back before every switch** (capture rotated refresh tokens into the outgoing
   snapshot) and **verify after** (re-read, compare). Applies to all three providers.
1b. **Account identity is (account_id, user_id)**, not account_id alone: a ChatGPT
   `account_id` is a workspace, and two seats share it while having separate rate
   limits and tokens. Attributing by workspace alone would make sync-back overwrite
   one seat's tokens with the other's. See `sameAccount()`.
1c. **Claude snapshots carry only the `claudeAiOauth` section** of the keychain item.
   The same item also holds `mcpOAuth` (MCP server tokens), which belongs to the
   machine, not the account — swapping it would sign you out of MCP servers.
2. **Copy, never symlink** — in-place refresh writes go through symlinks and corrupt
   snapshots (refresh-token rotation makes that unrecoverable).
3. **Rollout-file snapshots are only a fallback** for usage — they carry no account id.
   Live endpoints are primary; on 401, try one refresh; else serve last-known usage
   with `stale: true` and reset-aware decay (`now >= resetsAt → 0`).
3b. **The codex usage endpoint is flaky** (~1 reading in 12 returns an unrelated
   rate-limit bucket with a much lower `used_percent` and different reset stamps,
   independent of headers — reproduced live). Each read is a best-of-3 consensus:
   group samples by 5h `reset_at`, keep the majority bucket, take its highest
   `used_percent`. Conservative in both directions — an inflated candidate reading is
   never picked, an inflated active reading only rotates away sooner.
3c. **Usage reads never write credentials.** For the live account they read the CLI's
   own token file/keychain directly (it keeps them fresh); a read that synced back
   would race sibling reads and hand out half-swapped accounts.
4. **pi is a leave-running provider**: rotation swaps its auth file so *new* work uses
   the new account; running jobs finish on the old one.

## Store (Layer 0)

```
~/.codex-auth/
  codex/<name>.json      # full auth.json blobs
  claude/<name>.json     # {claudeAiOauth:{...}} blobs (keychain payload)
  pi/<name>.json         # full ~/.pi/agent/auth.json blobs
  state.json             # { active: {codex?, claude?, pi?}, rotations: [log] }
```

- Atomic writes (`tmp + rename`), mode 0600, dir 0700.
- One-time migration: `~/.codex/accounts/*.json` → `codex/` (originals left in place).
- `state.json` records what *we* activated; providers also self-report identity
  (email/account id) so drift is detectable.

## Auth API (Layer 1a)

```ts
interface AuthProvider {
  readonly id: 'codex' | 'claude' | 'pi'
  save(name): Promise<AccountRef>          // snapshot live credentials
  add(name): Promise<AccountRef>           // login flow that never logs out current
  activate(name): Promise<AccountRef>      // sync-back → swap → verify
  current(): Promise<AccountIdentity|null> // who is live NOW (email/account id)
  list(): Promise<AccountRef[]>
}
```

- codex: existing mechanics (CODEX_HOME-isolated add; file swap).
- claude: keychain read/write via `security find/add-generic-password`
  (first read triggers one macOS permission dialog — documented).
  `add` = save current → `claude /login` → save new → restore previous.
- pi: file swap of `~/.pi/agent/auth.json`.

## Limits API (Layer 1b)

```ts
interface RateLimitReader {
  read(ref: AccountRef): Promise<Usage>
}
type Usage = {
  windows: { kind: '5h'|'weekly'; usedPercent: number; resetsAt: Date|null }[]
  identity?: { email?: string; plan?: string }
  asOf: Date; stale: boolean; source: 'live'|'cache'
}
```

- Live endpoint per provider (above). 401 → one refresh attempt (persisting rotated
  tokens back to the snapshot atomically) → else cached-with-decay.
- Every successful live read also refreshes the cache (`<name>.usage.json` beside the
  snapshot) and re-verifies attribution via returned identity.

## Sessions API (Layer 2) — continuity strategies

- codex: existing discover (pgrep + lsof rollout fd → session uuid) / classify
  (user-tmux / user-tty / managed) / kill / resume. Managed (pi, desktop app) skipped.
- claude: no-op strategy (sessions survive swaps by design).
- pi: advisory only — reports running codex-engine jobs so the rotator can prefer
  quiet windows; never kills.

## Rotator (Layer 3)

```
rotate(provider):
  usage = limits.read(active)
  if usage.5h.usedPercent < threshold (default 95): done
  candidates = accounts \ {active}, each limits.read()
  pick min effective 5h usage (resetsAt-aware; skip unreadable/dead accounts)
  auth.activate(pick)                       # sync-back → swap → verify
  sessions.strategy(provider).restore()     # codex: kill+resume; claude/pi: none
  log rotation in state.json
```

- `watch`: loop over enabled providers every `--interval` (default 120s; usage reads
  are cheap GETs). Re-asserts the active account if a lingering session's refresh
  clobbered the swap (detected via identity mismatch, resolved by attributing the
  clobbered blob via identity endpoints, sync-back to its true owner, re-activate).
- Codex bonus (surfaced in `status`, not auto-consumed): rate-limit reset credits
  (`POST .../wham/rate-limit-reset-credits/consume`).

## CLI surface (thin)

```
codex-auth status [--json]                     # all providers × accounts × usage
codex-auth <provider> save|add|use|list|current [name]
codex-auth save|add|use|switch|list|current    # legacy top-level = codex provider
codex-auth switch <name>                       # codex use + kill/resume sessions
codex-auth rotate [--provider p] [--threshold 95] [--dry-run]
codex-auth watch [--interval 120] [--threshold 95] [--providers codex,claude,pi]
```

## Verification

Rotation policy is unit-tested against fake providers (`npm test`): threshold
behavior, least-used selection, dry-run, duplicate-account skipping, reset-aware
effective usage, unreadable-candidate skipping, all-exhausted, and clobber repair.
Provider mechanics were exercised live on macOS: codex kill+resume with history
intact, claude keychain swap with `mcpOAuth` preserved and the running session
unaffected, legacy snapshot migration, and consensus usage reads.

## Non-goals (v1)

- Cross-provider token hydration (e.g. injecting codex tokens into pi's
  `openai-codex` entry): sharing one rotating refresh token between two independent
  refreshers invalidates one of them. pi accounts are snapshotted whole instead.
- launchd daemon install (run `watch` under tmux for now).
- Windows/Linux keychain equivalents.
