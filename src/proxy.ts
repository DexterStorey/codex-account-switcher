import { z } from "zod";
import type { ProviderId } from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import type { FetchImplementation } from "./http.ts";

// The proxy is the whole point of the runtime: native Codex and Claude Code
// point their API traffic at it, and it swaps the active account's credential
// into every request. Because the active account is read per request, a switch
// takes effect on the very next request — including one mid-turn — with no
// changes to the client processes.

export interface UpstreamInjection {
  baseUrl: string;
  headers: Record<string, string>;
  // Merged into any existing comma-separated header value rather than
  // overwriting it — e.g. adding the OAuth beta without dropping the client's
  // own feature betas.
  appendHeaders?: Record<string, string>;
  stripHeaders?: readonly string[];
}

export interface ProxyCredentialSource {
  // Returns how to reach the upstream and what auth to inject for the active
  // account of a provider, or null when no account is active.
  resolve(provider: ProviderId): Promise<UpstreamInjection | null>;
  // Forces a credential refresh for the active account, used once on a 401.
  refresh(provider: ProviderId): Promise<void>;
}

export interface ProxyOptions {
  source: ProxyCredentialSource;
  fetchImplementation?: FetchImplementation;
  now?: () => number;
}

const hopByHopHeaders = [
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
];

const providerByPrefix: Record<string, ProviderId> = {
  openai: "openai",
  anthropic: "anthropic",
};

export const ProxyStateSchema = z
  .object({ port: z.number().int().positive(), pid: z.number().int().positive() })
  .strict();

function routeProvider(pathname: string): { provider: ProviderId; rest: string } | null {
  const match = pathname.match(/^\/(openai|anthropic)(\/.*)?$/);
  if (match === null) {
    return null;
  }
  const provider = providerByPrefix[match[1] ?? ""];
  return provider === undefined ? null : { provider, rest: match[2] ?? "/" };
}

function forwardHeaders(incoming: Headers, injection: UpstreamInjection): Headers {
  const headers = new Headers(incoming);
  for (const header of hopByHopHeaders) {
    headers.delete(header);
  }
  for (const header of injection.stripHeaders ?? []) {
    headers.delete(header);
  }
  for (const [name, value] of Object.entries(injection.headers)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(injection.appendHeaders ?? {})) {
    const existing = headers.get(name);
    const parts = new Set(
      (existing === null ? "" : existing)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
    parts.add(value);
    headers.set(name, [...parts].join(","));
  }
  return headers;
}

// A request body must survive one retry, so it is buffered when a retry is
// possible. Streaming request bodies (rare for these clients) are read once.
async function bufferBody(request: Request): Promise<ArrayBuffer | null> {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  return request.arrayBuffer();
}

export interface ProxyHandler {
  handle(request: Request): Promise<Response>;
}

export function createProxyHandler(options: ProxyOptions): ProxyHandler {
  const doFetch = options.fetchImplementation ?? fetch;
  return {
    async handle(request) {
      const url = new URL(request.url);
      const route = routeProvider(url.pathname);
      if (route === null) {
        return new Response("tokmax proxy: unknown route\n", { status: 404 });
      }
      const body = await bufferBody(request);
      const send = async (injection: UpstreamInjection): Promise<Response> => {
        const target = `${injection.baseUrl.replace(/\/$/, "")}${route.rest}${url.search}`;
        return doFetch(target, {
          method: request.method,
          headers: forwardHeaders(request.headers, injection),
          body: body === null ? undefined : body,
          redirect: "manual",
        });
      };

      let injection: UpstreamInjection | null;
      try {
        injection = await options.source.resolve(route.provider);
      } catch (error) {
        return new Response(`tokmax proxy: ${errorMessage(error)}\n`, { status: 502 });
      }
      if (injection === null) {
        return new Response(`tokmax proxy: no active ${route.provider} account\n`, { status: 503 });
      }

      let response: Response;
      try {
        response = await send(injection);
      } catch (error) {
        return new Response(`tokmax proxy: upstream unreachable (${errorMessage(error)})\n`, {
          status: 502,
        });
      }
      // A 401 means the injected token went stale between refresh cycles;
      // refresh once and replay the identical request so the client never sees
      // the transient failure.
      if (response.status === 401) {
        try {
          await options.source.refresh(route.provider);
          const refreshed = await options.source.resolve(route.provider);
          if (refreshed !== null) {
            response = await send(refreshed);
          }
        } catch {
          // Fall through with the original 401; the client can surface it.
        }
      }

      const responseHeaders = new Headers(response.headers);
      for (const header of ["content-encoding", "content-length", "transfer-encoding"]) {
        responseHeaders.delete(header);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    },
  };
}

export interface RunningProxy {
  port: number;
  stop(): Promise<void>;
}

export function startProxy(options: ProxyOptions & { port?: number }): RunningProxy {
  const handler = createProxyHandler(options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 240,
    fetch: (request) => handler.handle(request),
  });
  const port = server.port;
  if (port === undefined) {
    throw new ApplicationError("PROXY_BIND_FAILED", "Proxy did not bind a port");
  }
  return {
    port,
    async stop() {
      await server.stop(true);
    },
  };
}

export function upstreamFor(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      // The ChatGPT plan backend Codex's own client targets.
      return "https://chatgpt.com/backend-api/codex";
    case "anthropic":
      return "https://api.anthropic.com";
  }
  throw new ApplicationError("UNKNOWN_PROVIDER", `No upstream for provider ${provider}`);
}
