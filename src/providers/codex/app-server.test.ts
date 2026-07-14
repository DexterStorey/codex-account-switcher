import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { CodexAppServerClient } from "./app-server.ts";
import type { CodexAuth } from "./auth.ts";

interface StoppableServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

const servers: StoppableServer[] = [];
const MessageSchema = z
  .object({
    id: z.number().int().optional(),
    method: z.string().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function token(payload: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function credential(access = "access"): CodexAuth {
  return {
    tokens: {
      id_token: token({ email: "person@example.com", chatgpt_account_id: "account-1" }),
      access_token: token({ exp: 2_000_000_000, value: access }),
      refresh_token: "refresh",
    },
  };
}

async function fakeAppServer(input?: {
  threadStatus?: "notLoaded" | "idle" | "systemError" | "active";
  modelProvider?: string;
}): Promise<{
  endpoint: string;
  methods: string[];
  socket(): Bun.ServerWebSocket<undefined>;
  responses: Map<number, unknown>;
}> {
  const methods: string[] = [];
  const responses = new Map<number, unknown>();
  let activeSocket: Bun.ServerWebSocket<undefined> | null = null;
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        activeSocket = socket;
      },
      message(socket, data) {
        if (typeof data !== "string") {
          return;
        }
        const message = MessageSchema.parse(JSON.parse(data));
        if (message.method !== undefined) {
          methods.push(message.method);
        }
        if (message.id === 900 && message.result !== undefined) {
          responses.set(message.id, message.result);
          return;
        }
        if (message.id === undefined) {
          return;
        }
        switch (message.method) {
          case "initialize":
            socket.send(JSON.stringify({ id: message.id, result: {} }));
            break;
          case "account/login/start":
            socket.send(JSON.stringify({ id: message.id, result: { type: "chatgptAuthTokens" } }));
            break;
          case "account/read":
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
                  requiresOpenaiAuth: true,
                },
              }),
            );
            break;
          case "thread/loaded/list":
            socket.send(
              JSON.stringify({
                id: message.id,
                result: { data: ["thread-1"], nextCursor: null },
              }),
            );
            break;
          case "thread/read":
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  thread: {
                    id: "thread-1",
                    modelProvider: input?.modelProvider ?? "openai-http",
                    status:
                      input?.threadStatus === "active"
                        ? { type: "active", activeFlags: [] }
                        : { type: input?.threadStatus ?? "idle" },
                  },
                },
              }),
            );
            break;
          case "account/rateLimits/read":
            socket.send(
              JSON.stringify({
                id: message.id,
                result: {
                  rateLimits: {
                    limitId: "codex",
                    limitName: null,
                    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
                    secondary: null,
                    credits: null,
                    individualLimit: null,
                    planType: "pro",
                    rateLimitReachedType: null,
                  },
                  rateLimitsByLimitId: null,
                  rateLimitResetCredits: null,
                },
              }),
            );
            break;
        }
      },
    },
  });
  servers.push(server);
  return {
    endpoint: `ws://127.0.0.1:${server.port}`,
    methods,
    responses,
    socket() {
      if (activeSocket === null) {
        throw new Error("Client has not connected");
      }
      return activeSocket;
    },
  };
}

describe("Codex app-server client", () => {
  test("initializes, installs external auth, and drains only idle threads", async () => {
    const server = await fakeAppServer();
    const client = await CodexAppServerClient.connect(server.endpoint, "capability");
    await client.installCredential(credential());
    expect(await client.allThreadsIdle()).toBe(true);
    expect((await client.readRateLimits()).rateLimits.primary?.usedPercent).toBe(25);
    expect(server.methods).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "account/read",
      "thread/loaded/list",
      "thread/read",
      "account/rateLimits/read",
    ]);
    client.close();
  });

  test("treats only active managed-provider threads as busy", async () => {
    for (const status of ["idle", "notLoaded", "systemError"] as const) {
      const server = await fakeAppServer({ threadStatus: status });
      const client = await CodexAppServerClient.connect(server.endpoint, "capability");
      expect(await client.allThreadsIdle()).toBe(true);
      client.close();
    }
    const activeServer = await fakeAppServer({ threadStatus: "active" });
    const activeClient = await CodexAppServerClient.connect(activeServer.endpoint, "capability");
    expect(await activeClient.allThreadsIdle()).toBe(false);
    activeClient.close();

    const unsafeServer = await fakeAppServer({ modelProvider: "openai" });
    const unsafeClient = await CodexAppServerClient.connect(unsafeServer.endpoint, "capability");
    expect(await unsafeClient.allThreadsIdle()).toBe(false);
    unsafeClient.close();
  });

  test("answers the native external-token refresh callback", async () => {
    const server = await fakeAppServer();
    const client = await CodexAppServerClient.connect(server.endpoint, "capability");
    client.setCredentialSupplier(async () => credential("fresh"));
    server.socket().send(
      JSON.stringify({
        id: 900,
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized" },
      }),
    );
    for (let attempt = 0; attempt < 50 && !server.responses.has(900); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(server.responses.get(900)).toMatchObject({ chatgptAccountId: "account-1" });
    client.close();
  });
});
