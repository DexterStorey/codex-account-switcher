import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startCodexDispatchGate } from "./gate.ts";

interface StoppableServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

interface TestWebSocket {
  sendText(value: string): void;
  destroy(): void;
}

const temporaryDirectories: string[] = [];
const servers: StoppableServer[] = [];
const MethodMessageSchema = z.object({ method: z.string() }).passthrough();
const RequestMessageSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function maskedTextFrame(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  if (payload.length >= 126) {
    throw new Error("Test frame exceeds the compact WebSocket length form");
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % mask.length] ?? 0);
  }
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

async function connectTestWebSocket(socketPath: string): Promise<TestWebSocket> {
  const socket: Socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    [
      "GET /rpc HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  let response = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Test WebSocket upgrade timed out")), 2_000);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.once("error", reject);
  });
  if (!response.startsWith("HTTP/1.1 101")) {
    throw new Error(`Unexpected WebSocket response: ${response}`);
  }
  return {
    sendText(value) {
      socket.write(maskedTextFrame(value));
    },
    destroy() {
      socket.destroy();
    },
  };
}

describe("Codex dispatch gate", () => {
  test("queues new turns while continuing to forward control messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-gate-test-"));
    temporaryDirectories.push(directory);
    const clientPath = join(directory, "client.sock");
    const received: string[] = [];
    const native = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(_socket, data) {
          if (typeof data === "string") {
            received.push(MethodMessageSchema.parse(JSON.parse(data)).method);
          }
        },
      },
    });
    servers.push(native);
    const gate = await startCodexDispatchGate({
      clientSocketPath: clientPath,
      appServerEndpoint: `ws://127.0.0.1:${native.port}`,
      capabilityToken: "capability",
    });
    const client = await connectTestWebSocket(clientPath);
    gate.pause();
    client.sendText(JSON.stringify({ id: 1, method: "turn/start" }));
    client.sendText(JSON.stringify({ method: "initialized" }));
    await Bun.sleep(20);
    expect(received).toEqual(["initialized"]);
    gate.resume();
    await Bun.sleep(20);
    expect(received).toEqual(["initialized", "turn/start"]);
    expect(gate.hasPendingDispatch()).toBe(true);
    client.destroy();
    await gate.close();
  });

  test("tracks colliding request identifiers independently for every client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-gate-collision-test-"));
    temporaryDirectories.push(directory);
    const clientPath = join(directory, "client.sock");
    const upstreams: Bun.ServerWebSocket<undefined>[] = [];
    const native = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          upstreams.push(socket);
        },
        message() {},
      },
    });
    servers.push(native);
    const gate = await startCodexDispatchGate({
      clientSocketPath: clientPath,
      appServerEndpoint: `ws://127.0.0.1:${native.port}`,
      capabilityToken: "capability",
    });
    const first = await connectTestWebSocket(clientPath);
    const second = await connectTestWebSocket(clientPath);
    for (let attempt = 0; upstreams.length !== 2 && attempt < 100; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(upstreams).toHaveLength(2);

    first.sendText(JSON.stringify({ id: 1, method: "turn/start" }));
    second.sendText(JSON.stringify({ id: 1, method: "turn/start" }));
    await Bun.sleep(20);
    expect(gate.hasPendingDispatch()).toBe(true);

    upstreams[0]?.send(JSON.stringify({ id: 1, result: {} }));
    await Bun.sleep(20);
    expect(gate.hasPendingDispatch()).toBe(true);

    upstreams[1]?.send(JSON.stringify({ id: 1, result: {} }));
    await Bun.sleep(20);
    expect(gate.hasPendingDispatch()).toBe(false);

    first.destroy();
    second.destroy();
    await gate.close();
  });

  test("drops paused work when its client disconnects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-gate-disconnect-test-"));
    temporaryDirectories.push(directory);
    const clientPath = join(directory, "client.sock");
    const native = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: { message() {} },
    });
    servers.push(native);
    const gate = await startCodexDispatchGate({
      clientSocketPath: clientPath,
      appServerEndpoint: `ws://127.0.0.1:${native.port}`,
      capabilityToken: "capability",
    });
    const client = await connectTestWebSocket(clientPath);
    await Bun.sleep(20);
    gate.pause();
    client.sendText(JSON.stringify({ id: 1, method: "turn/start" }));
    await Bun.sleep(20);
    client.destroy();
    await Bun.sleep(20);
    gate.resume();
    expect(gate.hasPendingDispatch()).toBe(false);
    await gate.close();
  });

  test("keeps an accepted turn pending until its terminal notification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-gate-accepted-turn-test-"));
    temporaryDirectories.push(directory);
    const clientPath = join(directory, "client.sock");
    let upstream: Bun.ServerWebSocket<undefined> | null = null;
    const native = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          upstream = socket;
        },
        message(socket, data) {
          if (typeof data !== "string") {
            return;
          }
          const message = RequestMessageSchema.parse(JSON.parse(data));
          if (message.method === "turn/start" && message.id !== undefined) {
            socket.send(
              JSON.stringify({
                id: message.id,
                result: { turn: { id: "turn-1", status: "inProgress" } },
              }),
            );
          }
        },
      },
    });
    servers.push(native);
    const gate = await startCodexDispatchGate({
      clientSocketPath: clientPath,
      appServerEndpoint: `ws://127.0.0.1:${native.port}`,
      capabilityToken: "capability",
    });
    const client = await connectTestWebSocket(clientPath);
    client.sendText(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "t" } }));
    await Bun.sleep(20);
    expect(gate.hasPendingDispatch()).toBe(true);
    (upstream as Bun.ServerWebSocket<undefined> | null)?.send(
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "t", turn: { id: "turn-1", status: "completed" } },
      }),
    );
    await Bun.sleep(20);
    expect(gate.hasPendingDispatch()).toBe(false);
    client.destroy();
    await gate.close();
  });

  test("owns account mutation and forces the managed HTTP provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-gate-boundary-test-"));
    temporaryDirectories.push(directory);
    const clientPath = join(directory, "client.sock");
    const received: z.infer<typeof RequestMessageSchema>[] = [];
    const native = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(_socket, data) {
          if (typeof data === "string") {
            received.push(RequestMessageSchema.parse(JSON.parse(data)));
          }
        },
      },
    });
    servers.push(native);
    const gate = await startCodexDispatchGate({
      clientSocketPath: clientPath,
      appServerEndpoint: `ws://127.0.0.1:${native.port}`,
      capabilityToken: "capability",
    });
    const client = await connectTestWebSocket(clientPath);
    await Bun.sleep(20);
    client.sendText(JSON.stringify({ id: 1, method: "account/logout" }));
    client.sendText(
      JSON.stringify({
        id: 2,
        method: "thread/start",
        params: { modelProvider: "openai" },
      }),
    );
    await Bun.sleep(20);
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("thread/start");
    expect(received[0]?.params?.modelProvider).toBe("openai-http");
    client.destroy();
    await gate.close();
  });
});
