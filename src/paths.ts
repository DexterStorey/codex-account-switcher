import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const ApplicationPathsSchema = z.object({
  root: z.string().min(1),
  database: z.string().min(1),
  runtime: z.string().min(1),
  managerSocket: z.string().min(1),
  managerLock: z.string().min(1),
  codexClientSocket: z.string().min(1),
  codexCapabilityToken: z.string().min(1),
  codexHome: z.string().min(1),
  claudeProfiles: z.string().min(1),
  claudeActiveProfile: z.string().min(1),
});
export type ApplicationPaths = z.infer<typeof ApplicationPathsSchema>;

export function applicationPaths(environment: NodeJS.ProcessEnv = process.env): ApplicationPaths {
  const root = resolve(environment.CODEX_AUTH_HOME ?? join(homedir(), ".codex-auth"));
  const runtime = join(root, "runtime");
  const claudeProfiles = join(root, "profiles", "claude");

  return ApplicationPathsSchema.parse({
    root,
    database: join(root, "state.sqlite"),
    runtime,
    managerSocket: join(runtime, "manager.sock"),
    managerLock: join(runtime, "manager.lock"),
    codexClientSocket: join(runtime, "codex-client.sock"),
    codexCapabilityToken: join(runtime, "codex-app-server.token"),
    codexHome: join(root, "managed", "codex"),
    claudeProfiles,
    claudeActiveProfile: join(claudeProfiles, "active"),
  });
}

export async function ensureApplicationPaths(paths: ApplicationPaths): Promise<void> {
  const directories = [
    paths.root,
    paths.runtime,
    paths.codexHome,
    paths.claudeProfiles,
    paths.claudeActiveProfile,
  ];

  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  await Promise.all(directories.map((directory) => chmod(directory, 0o700)));
}
