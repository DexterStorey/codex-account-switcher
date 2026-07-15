import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installClaudeConfig,
  installCodexConfig,
  uninstallClaudeConfig,
  uninstallCodexConfig,
} from "./config-install.ts";
import { applicationPaths } from "./paths.ts";

const directories: string[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  process.env.CODEX_HOME = savedEnv.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = savedEnv.CLAUDE_CONFIG_DIR;
});

const paths = applicationPaths({
  TOKMAX_HOME: "/tmp/tokmax-config-test",
  TOKMAX_PROXY_PORT: "8459",
});

describe("codex config install", () => {
  test("adds a managed block, preserves user config, and round-trips uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-home-"));
    directories.push(home);
    process.env.CODEX_HOME = home;
    const original = 'model = "gpt-5"\nmodel_provider = "openai"\n\n[tui]\ntheme = "dark"\n';
    await writeFile(join(home, "config.toml"), original);

    await installCodexConfig(paths);
    const installed = await readFile(join(home, "config.toml"), "utf8");
    expect(installed).toContain('base_url = "http://127.0.0.1:8459/openai"');
    expect(installed).toContain('model_provider = "tokmax"');
    // The user's own model_provider is neutralized, not deleted.
    expect(installed).toContain('# tokmax-disabled: model_provider = "openai"');
    expect(installed).toContain('theme = "dark"');
    // Installing twice must not stack blocks.
    await installCodexConfig(paths);
    const twice = await readFile(join(home, "config.toml"), "utf8");
    expect(twice.match(/tokmax managed \(do not edit\)/g)).toHaveLength(1);

    await uninstallCodexConfig();
    const restored = await readFile(join(home, "config.toml"), "utf8");
    expect(restored).not.toContain("tokmax");
    expect(restored).toContain('model_provider = "openai"');
    expect(restored).toContain('theme = "dark"');
  });

  test("creates config for a fresh codex install", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-fresh-"));
    directories.push(home);
    process.env.CODEX_HOME = home;
    await installCodexConfig(paths);
    const installed = await readFile(join(home, "config.toml"), "utf8");
    expect(installed).toContain("[model_providers.tokmax]");
  });
});

describe("claude config install", () => {
  test("sets gateway env, preserves other settings, and round-trips uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-"));
    directories.push(home);
    process.env.CLAUDE_CONFIG_DIR = home;
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ theme: "dark", env: { FOO: "bar" } }),
    );

    await installClaudeConfig(paths);
    const installed = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    expect(installed.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8459/anthropic");
    expect(installed.env.ANTHROPIC_AUTH_TOKEN).toBe("managed-by-tokmax");
    expect(installed.env.FOO).toBe("bar");
    expect(installed.theme).toBe("dark");

    await uninstallClaudeConfig();
    const restored = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    expect(restored.env).toEqual({ FOO: "bar" });
    expect(restored.theme).toBe("dark");
  });

  test("removes an empty env block entirely on uninstall", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-empty-"));
    directories.push(home);
    process.env.CLAUDE_CONFIG_DIR = home;
    await installClaudeConfig(paths);
    await uninstallClaudeConfig();
    const restored = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    expect(restored.env).toBeUndefined();
  });
});
