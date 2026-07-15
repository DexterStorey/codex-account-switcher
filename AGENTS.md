# Engineering contract

- Use TypeScript, Zod 4, Bun, and Biome.
- Validate every external, IPC, persistence, and credential boundary.
- Do not use `any`, unchecked provider casts, shared mutable auth files, or hidden fallback flows.
- Keep provider accounts separate from runtime clients.
- The clients run natively; tokmax injects the active credential in the proxy, never by
  rewriting a running client's own auth files.
- Prefer pure functions, function declarations, descriptive camel-case names, and deterministic ordering.
- One abstraction owns each concept; provider-specific details stop at provider adapters.
- Never treat stale or missing usage as zero.
- Never invalidate an in-flight response or tool execution; a switch may only affect
  subsequent dispatches.
- Never write a token to logs, SQLite, a command-line argument, or source control.
- Add a regression test for every corrected auth, rate-limit, persistence, or continuity defect.
