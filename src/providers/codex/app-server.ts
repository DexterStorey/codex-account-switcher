import { z } from "zod";
import { createAuthenticatedWebSocket } from "../../bun-websocket.ts";
import { AccountEmailSchema } from "../../domain.ts";
import { ApplicationError } from "../../errors.ts";
import type { CodexAuth } from "./auth.ts";
import { codexIdentity } from "./auth.ts";

const JsonRpcResponseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

const ExternalRefreshRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal("account/chatgptAuthTokens/refresh"),
  params: z
    .object({
      reason: z.literal("unauthorized"),
      previousAccountId: z.string().nullable().optional(),
    })
    .strict(),
});

const LoginAccountResponseSchema = z.object({ type: z.literal("chatgptAuthTokens") }).strict();
const AccountReadResponseSchema = z
  .object({
    account: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("apiKey") }).passthrough(),
        z
          .object({ type: z.literal("chatgpt"), email: AccountEmailSchema.nullable() })
          .passthrough(),
        z.object({ type: z.literal("amazonBedrock") }).passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .strict();

const RateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationMins: z.number().nullable(),
  resetsAt: z.number().nullable(),
});

export const RateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable(),
    limitName: z.string().nullable(),
    primary: RateLimitWindowSchema.nullable(),
    secondary: RateLimitWindowSchema.nullable(),
    rateLimitReachedType: z.string().nullable().optional(),
  })
  .passthrough();

export const AccountRateLimitsResponseSchema = z.object({
  rateLimits: RateLimitSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshotSchema).nullable(),
  rateLimitResetCredits: z.unknown().nullable(),
});

const LoadedThreadsSchema = z.object({
  data: z.array(z.string()),
  nextCursor: z.string().nullable(),
});
const ThreadReadSchema = z.object({
  thread: z
    .object({
      id: z.string(),
      modelProvider: z.string(),
      status: z.discriminatedUnion("type", [
        z.object({ type: z.literal("notLoaded") }),
        z.object({ type: z.literal("idle") }),
        z.object({ type: z.literal("systemError") }),
        z.object({ type: z.literal("active"), activeFlags: z.array(z.unknown()) }),
      ]),
    })
    .passthrough(),
});

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #credentialSupplier: (() => Promise<CodexAuth>) | null = null;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.consume(event.data);
      }
    });
    socket.addEventListener("error", (error) => {
      this.#closed = true;
      this.failPending(error);
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      this.failPending(new ApplicationError("APP_SERVER_CLOSED", "Codex app-server disconnected"));
    });
  }

  public static async connect(
    endpoint: string,
    capabilityToken: string,
  ): Promise<CodexAppServerClient> {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const candidate = createAuthenticatedWebSocket(`${endpoint}/rpc`, capabilityToken);
      const timeout = setTimeout(() => {
        candidate.close();
        reject(new ApplicationError("APP_SERVER_TIMEOUT", "Codex app-server connect timed out"));
      }, 10_000);
      candidate.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve(candidate);
        },
        { once: true },
      );
      candidate.addEventListener(
        "error",
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        { once: true },
      );
    });
    const client = new CodexAppServerClient(socket);
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "tokmax",
          title: "tokmax",
          version: "0.3.0",
        },
        // account/login/start with chatgptAuthTokens is gated behind this
        // capability declaration in codex 0.144.x.
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  public close(): void {
    this.#closed = true;
    this.#socket.close();
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public setCredentialSupplier(supplier: () => Promise<CodexAuth>): void {
    this.#credentialSupplier = supplier;
  }

  public async installCredential(credential: CodexAuth): Promise<void> {
    const identity = codexIdentity(credential);
    LoginAccountResponseSchema.parse(
      await this.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: credential.tokens.access_token,
        chatgptAccountId: identity.accountId,
        chatgptPlanType: null,
      }),
    );
    const runtimeEmail = await this.runtimeEmail();
    const expectedEmail = AccountEmailSchema.parse(identity.email);
    if (runtimeEmail !== expectedEmail) {
      throw new ApplicationError(
        "IDENTITY_CHANGED",
        `Codex app-server installed ${runtimeEmail ?? "no ChatGPT identity"}, expected ${expectedEmail}`,
      );
    }
  }

  public async runtimeEmail(): Promise<string | null> {
    const response = AccountReadResponseSchema.parse(
      await this.request("account/read", { refreshToken: false }),
    );
    return response.account?.type === "chatgpt" ? response.account.email : null;
  }

  public async readRateLimits(): Promise<z.infer<typeof AccountRateLimitsResponseSchema>> {
    return AccountRateLimitsResponseSchema.parse(await this.request("account/rateLimits/read"));
  }

  public async loadedThreadIds(): Promise<string[]> {
    const identifiers: string[] = [];
    let cursor: string | null = null;
    do {
      const response = LoadedThreadsSchema.parse(
        await this.request("thread/loaded/list", { cursor, limit: 100 }),
      );
      identifiers.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor !== null);
    return identifiers;
  }

  public async allThreadsIdle(): Promise<boolean> {
    const identifiers = await this.loadedThreadIds();
    const threads = await Promise.all(
      identifiers.map((threadId) => this.request("thread/read", { threadId, includeTurns: false })),
    );
    return threads.every((response) => {
      const thread = ThreadReadSchema.parse(response).thread;
      return thread.modelProvider === "openai-http" && thread.status.type !== "active";
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new ApplicationError("APP_SERVER_CLOSED", `Cannot call ${method} after disconnect`),
      );
    }
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ApplicationError("APP_SERVER_TIMEOUT", `${method} timed out`));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: unknown): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new ApplicationError("APP_SERVER_CLOSED", "Codex app-server is not connected");
    }
    this.#socket.send(JSON.stringify(message));
  }

  private consume(serialized: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch {
      return;
    }
    const refreshRequest = ExternalRefreshRequestSchema.safeParse(decoded);
    if (refreshRequest.success) {
      void this.answerExternalRefresh(refreshRequest.data.id);
      return;
    }
    const candidate = JsonRpcResponseSchema.safeParse(decoded);
    if (!candidate.success || typeof candidate.data.id !== "number") {
      return;
    }
    const pending = this.#pending.get(candidate.data.id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(candidate.data.id);
    if (candidate.data.error !== undefined) {
      pending.reject(new ApplicationError("APP_SERVER_ERROR", candidate.data.error.message));
    } else {
      pending.resolve(candidate.data.result);
    }
  }

  private async answerExternalRefresh(id: string | number): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#credentialSupplier === null) {
      if (!this.#closed) {
        try {
          this.write({
            id,
            error: { code: -32001, message: "No managed Codex credential is active" },
          });
        } catch {
          return;
        }
      }
      return;
    }
    try {
      const credential = await this.#credentialSupplier();
      const identity = codexIdentity(credential);
      if (!this.#closed) {
        this.write({
          id,
          result: {
            accessToken: credential.tokens.access_token,
            chatgptAccountId: identity.accountId,
            chatgptPlanType: null,
          },
        });
      }
    } catch (error) {
      if (!this.#closed) {
        this.write({
          id,
          error: {
            code: -32002,
            message: error instanceof Error ? error.message : "Credential refresh failed",
          },
        });
      }
    }
  }

  private failPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
