import prompts from "prompts";
import { Command } from "@oclif/core";
import { AuthProvider } from "../auth/types";
import { snapshotStore } from "../store/store";
import { PromptCancelledError } from "../errors";

export async function doSave(cmd: Command, provider: AuthProvider, name: string): Promise<void> {
  const ref = await provider.save(name);
  cmd.log(`Saved current ${provider.displayName} credentials as "${ref.name}".`);
}

export async function doAdd(cmd: Command, provider: AuthProvider, name: string): Promise<void> {
  cmd.log(
    `Starting ${provider.displayName} login for a new account — your current session stays intact.`,
  );
  const ref = await provider.add(name);
  cmd.log(
    `Saved new ${provider.displayName} account "${ref.name}". Activate it with \`codex-auth ${provider.id} use ${ref.name}\`.`,
  );
}

export async function doUse(cmd: Command, provider: AuthProvider, name?: string): Promise<void> {
  const picked = name ?? (await pickAccount(provider));
  const ref = await provider.activate(picked);
  cmd.log(`Switched ${provider.displayName} credentials to "${ref.name}".`);
}

export async function doList(cmd: Command, provider: AuthProvider): Promise<void> {
  const names = await provider.list();
  if (!names.length) {
    cmd.log(`No saved ${provider.displayName} accounts yet. Run \`codex-auth ${provider.id} save <name>\`.`);
    return;
  }
  const active = await snapshotStore.getActive(provider.id);
  for (const name of names) {
    const identity = await provider.identityOf(name);
    const mark = active === name ? "*" : " ";
    const email = identity?.email ? `  (${identity.email})` : "";
    cmd.log(`${mark} ${name}${email}`);
  }
}

export async function doCurrent(cmd: Command, provider: AuthProvider): Promise<void> {
  const active = await snapshotStore.getActive(provider.id);
  const identity = await provider.current();
  if (!active && !identity) {
    cmd.log(`No active ${provider.displayName} account recorded.`);
    return;
  }
  const email = identity?.email ? ` (${identity.email})` : "";
  cmd.log(`${active ?? "unrecorded"}${email}`);
}

async function pickAccount(provider: AuthProvider): Promise<string> {
  const names = await provider.list();
  if (!names.length) {
    throw new Error(`No saved ${provider.displayName} accounts yet.`);
  }
  const active = await snapshotStore.getActive(provider.id);
  const response = await prompts(
    {
      type: "select",
      name: "account",
      message: `Select ${provider.displayName} account`,
      choices: names.map((name) => ({
        title: active === name ? `${name} (active)` : name,
        value: name,
      })),
      initial: active ? Math.max(names.indexOf(active), 0) : 0,
    },
    {
      onCancel: () => {
        throw new PromptCancelledError();
      },
    },
  );
  if (!response.account) throw new PromptCancelledError();
  return response.account as string;
}
