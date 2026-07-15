import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { ApplicationError } from "../../errors.ts";
import type { ApplicationPaths } from "../../paths.ts";

export const codexHttpProviderConfiguration = [
  "-c",
  'model_provider="openai-http"',
  "-c",
  'model_providers.openai-http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
] as const;

const LoopbackEndpointSchema = z.url().refine((endpoint) => {
  const parsed = new URL(endpoint);
  return parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1" && parsed.port !== "";
}, "Codex app-server must bind an explicit IPv4 loopback port");
const SupportedCodexVersionSchema = z
  .string()
  .trim()
  .regex(/^codex-cli 0\.144\.1$/, "Managed Codex requires codex-cli 0.144.1");

export interface ManagedCodexAppServer {
  processHandle: Bun.Subprocess;
  endpoint: string;
  capabilityToken: string;
}

async function readEndpoint(
  processHandle: Bun.Subprocess<"ignore", "ignore", "pipe">,
): Promise<string> {
  const reader = processHandle.stderr.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      throw new ApplicationError(
        "APP_SERVER_START_FAILED",
        `Codex app-server exited with ${await processHandle.exited}`,
      );
    }
    buffered += decoder.decode(next.value, { stream: true });
    const match = /listening on:\s+(ws:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
    if (match?.[1] !== undefined) {
      void (async () => {
        while (!(await reader.read()).done) {}
      })();
      return LoopbackEndpointSchema.parse(match[1]);
    }
    if (buffered.length > 32_768) {
      throw new ApplicationError(
        "APP_SERVER_START_FAILED",
        "Codex app-server did not report a loopback endpoint",
      );
    }
  }
}

export async function startManagedCodexAppServer(
  paths: ApplicationPaths,
): Promise<ManagedCodexAppServer> {
  const versionProcess = Bun.spawn(["codex", "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [versionExitCode, versionOutput] = await Promise.all([
    versionProcess.exited,
    new Response(versionProcess.stdout).text(),
  ]);
  if (versionExitCode !== 0) {
    throw new ApplicationError("CODEX_UNAVAILABLE", "Could not read the Codex CLI version");
  }
  try {
    SupportedCodexVersionSchema.parse(versionOutput);
  } catch (error) {
    throw new ApplicationError(
      "UNSUPPORTED_CODEX_VERSION",
      `Unsupported Codex CLI: ${versionOutput.trim() || "unknown"}`,
      { cause: error },
    );
  }
  const capabilityToken = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID();
  await Bun.write(paths.codexCapabilityToken, `${capabilityToken}\n`);
  await chmod(paths.codexCapabilityToken, 0o600);
  const processHandle = Bun.spawn(
    [
      "codex",
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      paths.codexCapabilityToken,
      ...codexHttpProviderConfiguration,
    ],
    {
      env: { ...process.env, CODEX_HOME: paths.codexHome },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  try {
    const endpoint = await Promise.race([
      readEndpoint(processHandle),
      Bun.sleep(10_000).then(() => {
        throw new ApplicationError(
          "APP_SERVER_START_TIMEOUT",
          "Codex app-server did not become ready within 10 seconds",
        );
      }),
    ]);
    return { processHandle, endpoint, capabilityToken };
  } catch (error) {
    processHandle.kill("SIGTERM");
    await Promise.race([processHandle.exited, Bun.sleep(2_000)]);
    if (processHandle.exitCode === null) {
      processHandle.kill("SIGKILL");
      await processHandle.exited;
    }
    await rm(paths.codexCapabilityToken, { force: true });
    throw error;
  }
}

// The shared app-server runs under the daemon, so a thread started without an
// explicit directory would fall back to the daemon's cwd instead of the
// directory the user launched from. Pin it unless the user already did.
export function codexLaunchArguments(
  clientSocketPath: string,
  launchDirectory: string,
  arguments_: readonly string[],
): string[] {
  const directoryOverridden = arguments_.some(
    (argument) => argument === "--cd" || argument === "-C" || argument.startsWith("--cd="),
  );
  return [
    "--remote",
    `unix://${clientSocketPath}`,
    ...(directoryOverridden ? [] : ["--cd", launchDirectory]),
    ...arguments_,
  ];
}

export async function runManagedCodex(
  paths: ApplicationPaths,
  arguments_: readonly string[],
): Promise<number> {
  const child = Bun.spawn(
    ["codex", ...codexLaunchArguments(paths.codexClientSocket, process.cwd(), arguments_)],
    {
      env: { ...process.env, CODEX_HOME: paths.codexHome },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return child.exited;
}
