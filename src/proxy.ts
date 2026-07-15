import type { ProviderId } from "./domain.ts";
import { ApplicationError, errorMessage } from "./errors.ts";
import type { FetchImplementation } from "./http.ts";

// The proxy is the whole point of the runtime: native Codex and Claude Code
// point their API traffic at it, and it swaps the active account's credential
// into every request. Because the active account is read per request, a switch
// takes effect on the very next request — including one mid-turn — with no
// changes to the client processes. It is a pure pass-through otherwise: it
// never buffers or times out a response, so long streaming turns are safe.

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
  // How to reach the upstream and what auth to inject for a provider's active
  // account, or null when no account is active.
  resolve(provider: ProviderId): Promise<UpstreamInjection | null>;
  // Forces a credential refresh for the active account, used once on a 401.
  refresh(provider: ProviderId): Promise<void>;
}

export interface ProxyOptions {
  source: ProxyCredentialSource;
  fetchImplementation?: FetchImplementation;
}

// Connection-level headers must not be forwarded; the runtime sets its own.
const strippedRequestHeaders = [
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
// Re-set by the response stream, so they must not carry over from upstream.
const strippedResponseHeaders = ["content-encoding", "content-length", "transfer-encoding"];

function routeProvider(pathname: string): { provider: ProviderId; rest: string } | null {
  const match = pathname.match(/^\/(openai|anthropic)(\/.*)?$/);
  if (match === null) {
    return null;
  }
  return { provider: match[1] as ProviderId, rest: match[2] ?? "/" };
}

function forwardHeaders(incoming: Headers, injection: UpstreamInjection): Headers {
  const headers = new Headers(incoming);
  for (const header of [...strippedRequestHeaders, ...(injection.stripHeaders ?? [])]) {
    headers.delete(header);
  }
  for (const [name, value] of Object.entries(injection.headers)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(injection.appendHeaders ?? {})) {
    const parts = new Set(
      (headers.get(name) ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
    parts.add(value);
    headers.set(name, [...parts].join(","));
  }
  return headers;
}

function passThrough(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const header of strippedResponseHeaders) {
    headers.delete(header);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
      // Buffered so the request can be replayed once after a 401 refresh; these
      // clients send a single complete JSON body, never a stream.
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const send = (injection: UpstreamInjection): Promise<Response> =>
        doFetch(`${injection.baseUrl.replace(/\/$/, "")}${route.rest}${url.search}`, {
          method: request.method,
          headers: forwardHeaders(request.headers, injection),
          body,
          redirect: "manual",
          // Propagate client disconnects to the upstream instead of leaking it.
          signal: request.signal,
        });

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
      // A 401 means the injected token went stale between refresh cycles: the
      // status arrives before any body, so refreshing and replaying once keeps
      // the client from ever seeing the transient failure.
      if (response.status === 401) {
        try {
          await response.body?.cancel();
          await options.source.refresh(route.provider);
          const refreshed = await options.source.resolve(route.provider);
          if (refreshed !== null) {
            response = await send(refreshed);
          }
        } catch {
          // Fall through with the original 401; the client can surface it.
        }
      }
      return passThrough(response);
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
    // Disabled: a streaming turn can idle between chunks (extended thinking,
    // tool round-trips) far longer than any fixed timeout, and cutting it is
    // exactly the "connection closed mid-response" failure.
    idleTimeout: 0,
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
