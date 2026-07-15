import { describe, expect, test } from "bun:test";
import { codexLaunchArguments } from "./supervisor.ts";

describe("managed codex launch", () => {
  test("pins the thread directory to the launch directory", () => {
    expect(codexLaunchArguments("/run/gate.sock", "/repos/project", ["resume"])).toEqual([
      "--remote",
      "unix:///run/gate.sock",
      "--cd",
      "/repos/project",
      "resume",
    ]);
  });

  test("respects an explicit user directory override", () => {
    for (const override of [["--cd", "/elsewhere"], ["-C", "/elsewhere"], ["--cd=/elsewhere"]]) {
      const launch = codexLaunchArguments("/run/gate.sock", "/repos/project", override);
      expect(launch).toEqual(["--remote", "unix:///run/gate.sock", ...override]);
    }
  });
});
