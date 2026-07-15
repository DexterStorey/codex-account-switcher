import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { z } from "zod";
import type { DashboardSnapshot, ProviderId } from "./domain.ts";
import { DashboardSnapshotSchema, ProviderIdSchema } from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import type { AccountManager } from "./manager.ts";

const RpcRequestSchema = z
  .object({
    id: z.number().int().nonnegative(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const RpcResponseSchema = z
  .object({
    id: z.literal(1),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict()
  .refine((response) => (response.result === undefined) !== (response.error === undefined), {
    message: "Manager response must contain exactly one result or error",
  });

const SwitchParamsSchema = z
  .object({
    provider: ProviderIdSchema,
    targetAccountId: z.uuid(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const PolicyParamsSchema = z
  .object({
    provider: ProviderIdSchema,
    enabled: z.boolean(),
    thresholdPercent: z.number().min(1).max(100).optional(),
    authorizationConfirmed: z.boolean().optional(),
  })
  .strict();

const PiSessionParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    processId: z.number().int().positive(),
    generation: z.number().int().nonnegative().optional(),
    state: z.enum(["idle", "working"]).optional(),
  })
  .strict();

export interface ManagerServer {
  close(): Promise<void>;
  finished: Promise<void>;
}

function writeResponse(socket: Socket, response: unknown): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

async function dispatch(
  manager: AccountManager,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case "manager/ping":
      return { ready: true, processId: process.pid };
    case "dashboard/read":
      return manager.dashboard();
    case "usage/refresh":
      await manager.refreshAll();
      return manager.dashboard();
    case "provider/ensure": {
      const parsed = z.object({ provider: ProviderIdSchema }).strict().parse(params);
      await manager.ensureProviderReady(parsed.provider);
      return { ready: true };
    }
    case "provider/switch": {
      const parsed = SwitchParamsSchema.parse(params);
      await manager.switchAccount(parsed.provider, parsed.targetAccountId, parsed.reason);
      return manager.dashboard();
    }
    case "policy/set": {
      const parsed = PolicyParamsSchema.parse(params);
      return manager.setAutomationPolicy(parsed);
    }
    case "pi/credential/read": {
      PiSessionParamsSchema.parse(params);
      return manager.currentPiCredential();
    }
    case "pi/turn/begin": {
      const parsed = PiSessionParamsSchema.parse(params);
      return manager.beginPiTurn({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
      });
    }
    case "pi/session/ack": {
      const parsed = PiSessionParamsSchema.parse(params);
      manager.updatePiSession({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
        generation: parsed.generation ?? 0,
        state: "idle",
      });
      return { acknowledged: true };
    }
    case "pi/session/state": {
      const parsed = PiSessionParamsSchema.parse(params);
      manager.updatePiSession({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
        generation: parsed.generation ?? 0,
        state: parsed.state ?? "idle",
      });
      return { acknowledged: true };
    }
    case "claude/session/start": {
      const parsed = PiSessionParamsSchema.parse(params);
      manager.updateClaudeSession({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
        state: "idle",
      });
      return { acknowledged: true };
    }
    case "claude/turn/begin": {
      const parsed = PiSessionParamsSchema.parse(params);
      return manager.beginClaudeTurn({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
      });
    }
    case "claude/turn/end": {
      const parsed = PiSessionParamsSchema.parse(params);
      manager.updateClaudeSession({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
        state: "idle",
      });
      return { acknowledged: true };
    }
    case "claude/session/end": {
      const parsed = PiSessionParamsSchema.parse(params);
      manager.removeClaudeSession({
        upstreamSessionId: parsed.sessionId,
        processId: parsed.processId,
      });
      return { acknowledged: true };
    }
    default:
      throw new ApplicationError("METHOD_NOT_FOUND", `Unknown manager method ${method}`);
  }
}

export async function startManagerServer(input: {
  manager: AccountManager;
  socketPath: string;
  onStop: () => void;
}): Promise<ManagerServer> {
  await rm(input.socketPath, { force: true });
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) {
          continue;
        }
        void (async () => {
          let decoded: unknown;
          try {
            decoded = JSON.parse(line);
          } catch {
            writeResponse(socket, {
              id: 0,
              error: { code: "INVALID_JSON", message: "Request is not valid JSON" },
            });
            return;
          }
          const parsed = RpcRequestSchema.safeParse(decoded);
          if (!parsed.success) {
            writeResponse(socket, {
              id: 0,
              error: { code: "INVALID_REQUEST", message: z.prettifyError(parsed.error) },
            });
            return;
          }
          if (parsed.data.method === "manager/stop") {
            writeResponse(socket, { id: parsed.data.id, result: { stopping: true } });
            setTimeout(input.onStop, 10);
            return;
          }
          try {
            const result = await dispatch(input.manager, parsed.data.method, parsed.data.params);
            writeResponse(socket, { id: parsed.data.id, result });
          } catch (error) {
            writeResponse(socket, {
              id: parsed.data.id,
              error: {
                code: error instanceof ApplicationError ? error.code : "INTERNAL_ERROR",
                message: errorMessage(error),
              },
            });
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, resolve);
  });
  await chmod(input.socketPath, 0o600);

  async function close(): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(input.socketPath, { force: true });
    finish?.();
  }

  return { close, finished };
}

export async function managerRequest<Result>(input: {
  socketPath: string;
  method: string;
  params?: unknown;
  schema: { parse(value: unknown): Result };
  timeoutMilliseconds?: number;
}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(input.socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new ApplicationError("MANAGER_TIMEOUT", `${input.method} timed out`));
    }, input.timeoutMilliseconds ?? 15_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: input.method, params: input.params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      clearTimeout(timeout);
      socket.end();
      try {
        const response = RpcResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (response.error !== undefined) {
          reject(new ApplicationError(response.error.code, response.error.message));
        } else {
          resolve(input.schema.parse(response.result));
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

export async function managerAvailable(socketPath: string): Promise<boolean> {
  return managerRequest({
    socketPath,
    method: "manager/ping",
    schema: z.object({ ready: z.literal(true), processId: z.number().int().positive() }),
    timeoutMilliseconds: 500,
  })
    .then(() => true)
    .catch(() => false);
}

export function readDashboard(socketPath: string): Promise<DashboardSnapshot> {
  return managerRequest({
    socketPath,
    method: "dashboard/read",
    schema: DashboardSnapshotSchema,
    timeoutMilliseconds: 15_000,
  });
}

export function refreshUsage(socketPath: string): Promise<DashboardSnapshot> {
  return managerRequest({
    socketPath,
    method: "usage/refresh",
    schema: DashboardSnapshotSchema,
    timeoutMilliseconds: 60_000,
  });
}

export function requestSwitch(
  socketPath: string,
  provider: ProviderId,
  targetAccountId: string,
): Promise<DashboardSnapshot> {
  return managerRequest({
    socketPath,
    method: "provider/switch",
    params: { provider, targetAccountId, reason: "manual" },
    schema: DashboardSnapshotSchema,
    // A switch legitimately waits for managed sessions to drain (60s budget)
    // plus credential refresh and verification round-trips.
    timeoutMilliseconds: 120_000,
  });
}
