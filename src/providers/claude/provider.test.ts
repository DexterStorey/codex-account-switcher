import { describe, expect, test } from "bun:test";
import { claudeAgentsIdle } from "./provider.ts";

describe("Claude runtime boundary", () => {
  test("treats only an empty active-agent listing as idle", () => {
    expect(claudeAgentsIdle([])).toBe(true);
    expect(claudeAgentsIdle({ agents: [] })).toBe(true);
    expect(claudeAgentsIdle([{ id: "active-without-status" }])).toBe(false);
    expect(claudeAgentsIdle({ agents: [{ status: "completed" }] })).toBe(false);
    expect(claudeAgentsIdle({ invalid: true })).toBe(false);
  });
});
