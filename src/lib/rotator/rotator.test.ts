import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderId, SnapshotStore } from "../store/store";
import { AccountIdentity, AccountRef, AuthProvider } from "../auth/types";
import { RateLimitReader, Usage, UsageWindow } from "../limits/types";
import { ProviderStack, Rotator } from "./rotator";

const HOUR = 3600_000;

function usage(account: string, fiveHourPercent: number | null, resetsInMs = 2 * HOUR): Usage {
  const windows: UsageWindow[] = [];
  if (fiveHourPercent !== null) {
    windows.push({
      kind: "5h",
      usedPercent: fiveHourPercent,
      resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
      windowMinutes: 300,
    });
  }
  return {
    provider: "claude",
    account,
    windows,
    identity: { email: `${account}@example.com`, plan: "max" },
    asOf: new Date().toISOString(),
    source: "live",
    stale: false,
  };
}

class FakeAuth implements AuthProvider {
  public readonly id: ProviderId = "claude";
  public readonly displayName = "Fake";
  public activated: string[] = [];
  public live: string;

  constructor(
    private readonly accounts: Record<string, AccountIdentity>,
    live: string,
  ) {
    this.live = live;
  }

  async save(name: string): Promise<AccountRef> {
    return { provider: this.id, name };
  }
  async add(name: string): Promise<AccountRef> {
    return { provider: this.id, name };
  }
  async activate(name: string): Promise<AccountRef> {
    this.activated.push(name);
    this.live = name;
    return { provider: this.id, name };
  }
  async current(): Promise<AccountIdentity | null> {
    return this.accounts[this.live] ?? null;
  }
  async identityOf(name: string): Promise<AccountIdentity | null> {
    return this.accounts[name] ?? null;
  }
  async list(): Promise<string[]> {
    return Object.keys(this.accounts);
  }
}

class FakeLimits implements RateLimitReader {
  public readonly provider: ProviderId = "claude";
  constructor(private readonly usages: Record<string, Usage>) {}
  async read(account: string): Promise<Usage> {
    return this.usages[account] ?? usage(account, null);
  }
}

async function makeRotator(
  auth: FakeAuth,
  limits: FakeLimits,
): Promise<{ rotator: Rotator; store: SnapshotStore }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rotator-test-"));
  const store = new SnapshotStore(root);
  const stack: ProviderStack = { auth, limits, restartsSessions: false };
  const registry = { codex: stack, claude: stack, pi: stack } as Record<ProviderId, ProviderStack>;
  return { rotator: new Rotator(registry, store), store };
}

const identity = (id: string, email: string): AccountIdentity => ({
  accountId: id,
  userId: id,
  email,
});

test("stays put when the active account is below threshold", async () => {
  const auth = new FakeAuth(
    { a: identity("A", "a@x.com"), b: identity("B", "b@x.com") },
    "a",
  );
  const limits = new FakeLimits({ a: usage("a", 40), b: usage("b", 5) });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.rotated, false);
  assert.equal(decision.shouldRotate, false);
  assert.deepEqual(auth.activated, []);
});

test("rotates to the least-used account when past threshold", async () => {
  const auth = new FakeAuth(
    { a: identity("A", "a@x.com"), b: identity("B", "b@x.com"), c: identity("C", "c@x.com") },
    "a",
  );
  const limits = new FakeLimits({
    a: usage("a", 96),
    b: usage("b", 60),
    c: usage("c", 12), // least used → should win
  });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.rotated, true);
  assert.equal(decision.to, "c");
  assert.deepEqual(auth.activated, ["c"]);
});

test("dry-run decides but never activates", async () => {
  const auth = new FakeAuth({ a: identity("A", "a@x.com"), b: identity("B", "b@x.com") }, "a");
  const limits = new FakeLimits({ a: usage("a", 99), b: usage("b", 3) });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95, dryRun: true });
  assert.equal(decision.rotated, false);
  assert.equal(decision.to, "b");
  assert.deepEqual(auth.activated, []);
});

test("never rotates onto a duplicate of the active account", async () => {
  const dup = identity("A", "a@x.com");
  const auth = new FakeAuth({ a: dup, a_copy: dup, b: identity("B", "b@x.com") }, "a");
  const limits = new FakeLimits({
    a: usage("a", 99),
    a_copy: usage("a_copy", 0), // looks idle, but it is the SAME account
    b: usage("b", 50),
  });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.to, "b");
  assert.deepEqual(auth.activated, ["b"]);
});

test("treats a candidate whose window already reset as empty", async () => {
  const auth = new FakeAuth(
    { a: identity("A", "a@x.com"), b: identity("B", "b@x.com"), c: identity("C", "c@x.com") },
    "a",
  );
  const limits = new FakeLimits({
    a: usage("a", 97),
    b: usage("b", 20),
    c: usage("c", 88, -HOUR), // 88% but the window reset an hour ago → effectively 0
  });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.to, "c");
});

test("skips candidates with no readable usage", async () => {
  const auth = new FakeAuth(
    { a: identity("A", "a@x.com"), b: identity("B", "b@x.com"), c: identity("C", "c@x.com") },
    "a",
  );
  const limits = new FakeLimits({
    a: usage("a", 96),
    b: usage("b", null), // unreadable (dead token) — must not be chosen
    c: usage("c", 70),
  });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.to, "c");
});

test("does not rotate when every candidate is also exhausted", async () => {
  const auth = new FakeAuth({ a: identity("A", "a@x.com"), b: identity("B", "b@x.com") }, "a");
  const limits = new FakeLimits({ a: usage("a", 99), b: usage("b", 97) });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.rotated, false);
  assert.equal(decision.shouldRotate, true);
  assert.match(decision.reason, /all candidates/);
  assert.deepEqual(auth.activated, []);
});

test("does nothing with fewer than two accounts", async () => {
  const auth = new FakeAuth({ a: identity("A", "a@x.com") }, "a");
  const limits = new FakeLimits({ a: usage("a", 100) });
  const { rotator } = await makeRotator(auth, limits);

  const decision = await rotator.rotate("claude", { threshold: 95 });
  assert.equal(decision.rotated, false);
  assert.deepEqual(auth.activated, []);
});

test("reassert repairs live credentials clobbered by another account", async () => {
  const auth = new FakeAuth({ a: identity("A", "a@x.com"), b: identity("B", "b@x.com") }, "a");
  const limits = new FakeLimits({ a: usage("a", 10), b: usage("b", 10) });
  const { rotator, store } = await makeRotator(auth, limits);

  await store.setActive("claude", "b"); // we switched to b...
  auth.live = "a"; //  ...but a lingering session wrote a's tokens back

  const repaired = await rotator.reassert("claude");
  assert.equal(repaired, true);
  assert.deepEqual(auth.activated, ["b"]);
});

test("reassert is a no-op when live credentials match the active account", async () => {
  const auth = new FakeAuth({ a: identity("A", "a@x.com"), b: identity("B", "b@x.com") }, "b");
  const limits = new FakeLimits({ a: usage("a", 10), b: usage("b", 10) });
  const { rotator, store } = await makeRotator(auth, limits);

  await store.setActive("claude", "b");
  assert.equal(await rotator.reassert("claude"), false);
  assert.deepEqual(auth.activated, []);
});
