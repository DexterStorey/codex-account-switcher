import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  hasApi,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  closeOpenAICodexWebSocketSessions,
  streamSimple as streamOpenAiCodex,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { z } from "zod";

const ManagedCredentialSchema = z.object({
  provider: z.literal("openai"),
  generation: z.number().int().nonnegative(),
  accessToken: z.string().min(1),
  accountId: z.string().min(1),
});
type ManagedCredential = z.infer<typeof ManagedCredentialSchema>;

export function managedCredentialsDiffer(
  current: ManagedCredential | null,
  next: ManagedCredential,
): boolean {
  return (
    current?.generation !== next.generation ||
    current.accessToken !== next.accessToken ||
    current.accountId !== next.accountId
  );
}

export function createManagedCodexStreamSimple<Result>(
  readCredential: () => ManagedCredential | null,
  delegate: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Result,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Result {
  return function managedCodexStream(model, context, options) {
    if (model.provider !== "openai-codex") {
      return delegate(model, context, options);
    }
    const current = readCredential();
    if (current === null) {
      throw new Error("Managed OpenAI credential is unavailable");
    }
    return delegate(model, context, { ...options, apiKey: current.accessToken });
  };
}

const ManagerResponseSchema = z
  .object({
    id: z.literal(1),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict()
  .refine((response) => (response.result === undefined) !== (response.error === undefined), {
    message: "Manager response must contain exactly one result or error",
  });

interface PiContext {
  model: { provider: string } | undefined;
  sessionManager: { getSessionId(): string };
}

interface PiExtensionApi {
  on(event: "session_start", handler: (event: unknown, context: PiContext) => Promise<void>): void;
  on(event: "agent_settled", handler: (event: unknown, context: PiContext) => Promise<void>): void;
  on(event: "agent_start", handler: (event: unknown, context: PiContext) => Promise<void>): void;
  on(event: "turn_start", handler: (event: unknown, context: PiContext) => Promise<void>): void;
  on(event: "turn_end", handler: (event: unknown, context: PiContext) => Promise<void>): void;
  on(
    event: "before_agent_start",
    handler: (event: unknown, context: PiContext) => Promise<void>,
  ): void;
  registerProvider(
    name: string,
    configuration: {
      api: Api;
      apiKey: string;
      streamSimple: (
        model: Model<Api>,
        context: Context,
        options?: SimpleStreamOptions,
      ) => AssistantMessageEventStream;
    },
  ): void;
}

function delegateOpenAiCodexStream(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (!hasApi(model, "openai-codex-responses")) {
    throw new Error(`Expected openai-codex-responses, received ${model.api}`);
  }
  return streamOpenAiCodex(model, context, options);
}

function managerSocketPath(): string {
  return process.env.TOKMAX_SOCKET ?? join(homedir(), ".codex-auth", "runtime", "manager.sock");
}

async function managerRequest(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(managerSocketPath());
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Manager request ${method} timed out`));
    }, 180_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      clearTimeout(timeout);
      socket.end();
      try {
        const response = ManagerResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (response.error !== undefined) {
          reject(new Error(response.error.message));
        } else {
          resolve(response.result);
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export default function managedPiExtension(pi: PiExtensionApi): void {
  let credential: ManagedCredential | null = null;
  const managedStream = createManagedCodexStreamSimple(() => credential, delegateOpenAiCodexStream);
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    apiKey: "managed-by-tokmax",
    streamSimple: managedStream,
  });

  async function synchronize(context: PiContext): Promise<void> {
    if (context.model?.provider !== "openai-codex") {
      return;
    }
    const next = ManagedCredentialSchema.parse(
      await managerRequest("pi/credential/read", {
        sessionId: context.sessionManager.getSessionId(),
        processId: process.pid,
      }),
    );
    await applyCredential(context, next, true);
  }

  async function applyCredential(
    context: PiContext,
    next: ManagedCredential,
    acknowledgeIdle: boolean,
  ): Promise<void> {
    if (managedCredentialsDiffer(credential, next)) {
      closeOpenAICodexWebSocketSessions(context.sessionManager.getSessionId());
      credential = next;
    }
    if (acknowledgeIdle) {
      await managerRequest("pi/session/ack", {
        sessionId: context.sessionManager.getSessionId(),
        processId: process.pid,
        generation: next.generation,
      });
    }
  }

  async function beginTurn(context: PiContext): Promise<void> {
    if (context.model?.provider !== "openai-codex") {
      return;
    }
    const next = ManagedCredentialSchema.parse(
      await managerRequest("pi/turn/begin", {
        sessionId: context.sessionManager.getSessionId(),
        processId: process.pid,
      }),
    );
    await applyCredential(context, next, false);
  }

  async function reportState(
    context: PiContext,
    state: "idle" | "working",
    force = false,
  ): Promise<void> {
    if (context.model?.provider !== "openai-codex" && !(force && credential !== null)) {
      return;
    }
    await managerRequest("pi/session/state", {
      sessionId: context.sessionManager.getSessionId(),
      processId: process.pid,
      generation: credential?.generation ?? 0,
      state,
    });
  }

  pi.on("session_start", async (_event, context) => synchronize(context));
  pi.on("before_agent_start", async (_event, context) => synchronize(context));
  pi.on("agent_start", async (_event, context) => reportState(context, "working"));
  pi.on("turn_start", async (_event, context) => {
    await beginTurn(context);
  });
  pi.on("turn_end", async (_event, context) => {
    await reportState(context, "idle");
    await synchronize(context);
  });
  pi.on("agent_settled", async (_event, context) => {
    await reportState(context, "idle", true);
    await synchronize(context);
  });
}
