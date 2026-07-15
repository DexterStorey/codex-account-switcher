import { describe, expect, test } from "bun:test";
import { createProxyHandler, type ProxyCredentialSource, type UpstreamInjection } from "./proxy.ts";

function source(overrides: Partial<ProxyCredentialSource> = {}): ProxyCredentialSource {
  return {
    resolve: async () => ({
      baseUrl: "https://upstream.example",
      headers: { authorization: "Bearer token-1" },
    }),
    refresh: async () => undefined,
    ...overrides,
  };
}

describe("proxy handler", () => {
  test("injects the active credential and forwards to the routed upstream", async () => {
    const requests: Array<{ url: string; auth: string | null; method: string }> = [];
    const handler = createProxyHandler({
      source: source({
        resolve: async (provider) => ({
          baseUrl: provider === "openai" ? "https://chatgpt.test/codex" : "https://anthropic.test",
          headers: { authorization: `Bearer ${provider}-token` },
        }),
      }),
      fetchImplementation: async (input, init) => {
        requests.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        return new Response("ok", { status: 200 });
      },
    });

    await handler.handle(
      new Request("http://127.0.0.1/openai/responses", { method: "POST", body: "{}" }),
    );
    await handler.handle(
      new Request("http://127.0.0.1/anthropic/v1/messages?beta=true", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(requests[0]).toEqual({
      url: "https://chatgpt.test/codex/responses",
      auth: "Bearer openai-token",
      method: "POST",
    });
    expect(requests[1]).toEqual({
      url: "https://anthropic.test/v1/messages?beta=true",
      auth: "Bearer anthropic-token",
      method: "POST",
    });
  });

  test("refreshes once and replays the request on a 401", async () => {
    let refreshed = false;
    let currentToken = "stale";
    const seenTokens: string[] = [];
    const handler = createProxyHandler({
      source: {
        resolve: async (): Promise<UpstreamInjection> => ({
          baseUrl: "https://upstream.example",
          headers: { authorization: `Bearer ${currentToken}` },
        }),
        refresh: async () => {
          refreshed = true;
          currentToken = "fresh";
        },
      },
      fetchImplementation: async (_input, init) => {
        const token = new Headers(init?.headers).get("authorization") ?? "";
        seenTokens.push(token);
        return new Response("", { status: token.includes("stale") ? 401 : 200 });
      },
    });

    const response = await handler.handle(
      new Request("http://127.0.0.1/openai/responses", { method: "POST", body: "{}" }),
    );
    expect(refreshed).toBe(true);
    expect(response.status).toBe(200);
    expect(seenTokens).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  test("returns 503 when no account is active and never calls upstream", async () => {
    let called = false;
    const handler = createProxyHandler({
      source: source({ resolve: async () => null }),
      fetchImplementation: async () => {
        called = true;
        return new Response("", { status: 200 });
      },
    });
    const response = await handler.handle(new Request("http://127.0.0.1/openai/responses"));
    expect(response.status).toBe(503);
    expect(called).toBe(false);
  });

  test("rejects unknown routes without touching upstream", async () => {
    const handler = createProxyHandler({ source: source() });
    const response = await handler.handle(new Request("http://127.0.0.1/wat/responses"));
    expect(response.status).toBe(404);
  });

  test("strips hop-by-hop and provider-conflicting headers", async () => {
    let forwarded: Headers | undefined;
    const handler = createProxyHandler({
      source: source({
        resolve: async () => ({
          baseUrl: "https://upstream.example",
          headers: { authorization: "Bearer token-1" },
          stripHeaders: ["x-api-key"],
        }),
      }),
      fetchImplementation: async (_input, init) => {
        forwarded = new Headers(init?.headers);
        return new Response("", { status: 200 });
      },
    });
    await handler.handle(
      new Request("http://127.0.0.1/anthropic/v1/messages", {
        method: "POST",
        body: "{}",
        headers: { "x-api-key": "leak", connection: "keep-alive", "x-keep": "yes" },
      }),
    );
    expect(forwarded?.get("x-api-key")).toBeNull();
    expect(forwarded?.get("connection")).toBeNull();
    expect(forwarded?.get("x-keep")).toBe("yes");
    expect(forwarded?.get("authorization")).toBe("Bearer token-1");
  });
});
