import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { createAuthenticatedWebSocket } from "../../bun-websocket.ts";

const gatedMethods = new Set([
  "turn/start",
  "turn/steer",
  "review/start",
  "thread/compact/start",
  "thread/realtime/start",
]);
const managedProviderMethods = new Set(["thread/start", "thread/resume", "thread/fork"]);
const blockedAccountMethods = new Set([
  "account/login/start",
  "account/login/cancel",
  "account/logout",
]);
const DownstreamMessageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type MessageData = string | Buffer;

interface GateConnection {
  upstream: WebSocket | null;
  awaitingUpstream: MessageData[];
}

interface QueuedMessage {
  upstream: WebSocket;
  client: Bun.ServerWebSocket<GateConnection>;
  data: MessageData;
}

interface PendingDispatch {
  method: string;
  threadId: string | null;
}

export interface CodexDispatchGate {
  pause(): void;
  resume(): void;
  hasPendingDispatch(): boolean;
  close(): Promise<void>;
}

interface JsonRpcEnvelope {
  id: string | number | null;
  method: string | null;
  value: Record<string, unknown> | null;
}

function envelope(data: MessageData): JsonRpcEnvelope {
  if (typeof data !== "string") {
    return { id: null, method: null, value: null };
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { id: null, method: null, value: null };
    }
    const id = "id" in parsed ? Reflect.get(parsed, "id") : null;
    const method = Reflect.get(parsed, "method");
    return {
      id: typeof id === "string" || typeof id === "number" ? id : null,
      method: typeof method === "string" ? method : null,
      value: parsed as Record<string, unknown>,
    };
  } catch {
    return { id: null, method: null, value: null };
  }
}

function nestedString(value: Record<string, unknown> | null, ...path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return null;
    }
    current = Reflect.get(current, segment);
  }
  return typeof current === "string" ? current : null;
}

function managedDownstreamMessage(data: MessageData): MessageData {
  if (typeof data !== "string") {
    return data;
  }
  try {
    const parsed = DownstreamMessageSchema.safeParse(JSON.parse(data));
    if (!parsed.success || !managedProviderMethods.has(parsed.data.method ?? "")) {
      return data;
    }
    return JSON.stringify({
      ...parsed.data,
      params: { ...parsed.data.params, modelProvider: "openai-http" },
    });
  } catch {
    return data;
  }
}

function requestKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function upstreamMessage(data: unknown): MessageData | null {
  switch (true) {
    case typeof data === "string":
      return data;
    case Buffer.isBuffer(data):
      return data;
    case data instanceof ArrayBuffer:
      return Buffer.from(data);
    default:
      return null;
  }
}

function sendUpstream(upstream: WebSocket, data: MessageData): boolean {
  if (upstream.readyState !== WebSocket.OPEN) {
    return false;
  }
  upstream.send(data);
  return true;
}

export async function startCodexDispatchGate(input: {
  clientSocketPath: string;
  appServerEndpoint: string;
  capabilityToken: string;
}): Promise<CodexDispatchGate> {
  await rm(input.clientSocketPath, { force: true });
  let paused = false;
  const queued: QueuedMessage[] = [];
  const upstreamConnections = new Set<WebSocket>();
  const downstreamConnections = new Set<Bun.ServerWebSocket<GateConnection>>();
  const pendingDispatches = new Map<WebSocket, Map<string, PendingDispatch>>();
  const acceptedDispatches = new Map<WebSocket, Set<string>>();

  function forgetUpstream(upstream: WebSocket): void {
    pendingDispatches.delete(upstream);
    acceptedDispatches.delete(upstream);
    for (let index = queued.length - 1; index >= 0; index -= 1) {
      if (queued[index]?.upstream === upstream) {
        queued.splice(index, 1);
      }
    }
  }

  function dispatch(
    client: Bun.ServerWebSocket<GateConnection>,
    upstream: WebSocket,
    original: MessageData,
  ): void {
    if (upstream.readyState !== WebSocket.OPEN) {
      return;
    }
    const initial = envelope(original);
    if (initial.method !== null && blockedAccountMethods.has(initial.method)) {
      if (initial.id !== null) {
        client.send(
          JSON.stringify({
            id: initial.id,
            error: {
              code: -32090,
              message: "Managed Codex authentication is controlled by codex-auth",
            },
          }),
        );
      }
      return;
    }
    const data = managedDownstreamMessage(original);
    const request = envelope(data);
    if (paused && request.method !== null && gatedMethods.has(request.method)) {
      queued.push({ client, upstream, data });
      return;
    }
    if (!sendUpstream(upstream, data)) {
      return;
    }
    if (request.id !== null && request.method !== null && gatedMethods.has(request.method)) {
      const requests = pendingDispatches.get(upstream) ?? new Map<string, PendingDispatch>();
      requests.set(requestKey(request.id), {
        method: request.method,
        threadId: nestedString(request.value, "params", "threadId"),
      });
      pendingDispatches.set(upstream, requests);
    }
  }

  function consumeUpstream(upstream: WebSocket, data: MessageData): boolean {
    const response = envelope(data);
    if (response.method === "account/chatgptAuthTokens/refresh" && response.id !== null) {
      sendUpstream(
        upstream,
        JSON.stringify({
          id: response.id,
          error: { code: -32091, message: "Use the manager credential channel" },
        }),
      );
      return false;
    }
    if (response.id !== null && response.method === null) {
      const requests = pendingDispatches.get(upstream);
      const key = requestKey(response.id);
      const pending = requests?.get(key);
      requests?.delete(key);
      if (requests?.size === 0) {
        pendingDispatches.delete(upstream);
      }
      const failed = response.value !== null && Reflect.has(response.value, "error");
      if (!failed && pending !== undefined) {
        const accepted = acceptedDispatches.get(upstream) ?? new Set<string>();
        const turnId =
          nestedString(response.value, "result", "turn", "id") ??
          nestedString(response.value, "result", "turnId");
        switch (pending.method) {
          case "turn/start":
          case "turn/steer":
          case "review/start":
            if (turnId !== null) {
              accepted.add(`turn:${turnId}`);
            }
            break;
          case "thread/compact/start":
            if (pending.threadId !== null) {
              accepted.add(`compact:${pending.threadId}`);
            }
            break;
          case "thread/realtime/start":
            if (pending.threadId !== null) {
              accepted.add(`realtime:${pending.threadId}`);
            }
            break;
        }
        if (accepted.size > 0) {
          acceptedDispatches.set(upstream, accepted);
        }
      }
    }
    const accepted = acceptedDispatches.get(upstream);
    if (accepted !== undefined && response.method !== null) {
      const turnId = nestedString(response.value, "params", "turn", "id");
      const threadId = nestedString(response.value, "params", "threadId");
      switch (response.method) {
        case "turn/started":
          if (turnId !== null) {
            accepted.add(`turn:${turnId}`);
          }
          break;
        case "turn/completed":
          if (turnId !== null) {
            accepted.delete(`turn:${turnId}`);
          }
          break;
        case "thread/compacted":
          if (threadId !== null) {
            accepted.delete(`compact:${threadId}`);
          }
          break;
        case "thread/realtime/closed":
        case "thread/realtime/error":
          if (threadId !== null) {
            accepted.delete(`realtime:${threadId}`);
          }
          break;
      }
      if (accepted.size === 0) {
        acceptedDispatches.delete(upstream);
      }
    }
    return true;
  }

  const server = Bun.serve<GateConnection>({
    unix: input.clientSocketPath,
    fetch(request, server) {
      const upgraded = server.upgrade(request, {
        data: { upstream: null, awaitingUpstream: [] },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      open(client) {
        downstreamConnections.add(client);
        const upstream = createAuthenticatedWebSocket(
          `${input.appServerEndpoint}/rpc`,
          input.capabilityToken,
        );
        client.data.upstream = upstream;
        upstreamConnections.add(upstream);
        upstream.addEventListener("open", () => {
          for (const data of client.data.awaitingUpstream.splice(0)) {
            dispatch(client, upstream, data);
          }
        });
        upstream.addEventListener("message", (event) => {
          const data = upstreamMessage(event.data);
          if (data !== null && consumeUpstream(upstream, data)) {
            client.send(data);
          }
        });
        upstream.addEventListener("close", () => {
          upstreamConnections.delete(upstream);
          forgetUpstream(upstream);
          client.terminate();
        });
        upstream.addEventListener("error", () => {
          client.terminate();
        });
      },
      message(client, data) {
        const upstream = client.data.upstream;
        const copied = typeof data === "string" ? data : Buffer.from(data);
        if (upstream === null || upstream.readyState === WebSocket.CONNECTING) {
          client.data.awaitingUpstream.push(copied);
          return;
        }
        dispatch(client, upstream, copied);
      },
      close(client) {
        downstreamConnections.delete(client);
        const upstream = client.data.upstream;
        if (upstream !== null) {
          upstreamConnections.delete(upstream);
          forgetUpstream(upstream);
          upstream.close();
        }
      },
    },
  });
  await chmod(input.clientSocketPath, 0o600);

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const outgoing of queued.splice(0)) {
        dispatch(outgoing.client, outgoing.upstream, outgoing.data);
      }
    },
    hasPendingDispatch() {
      return pendingDispatches.size > 0 || acceptedDispatches.size > 0;
    },
    async close() {
      queued.splice(0);
      for (const downstream of downstreamConnections) {
        downstream.terminate();
      }
      for (const upstream of upstreamConnections) {
        upstream.close();
      }
      void server.stop(true).catch(() => undefined);
      await rm(input.clientSocketPath, { force: true });
    },
  };
}
