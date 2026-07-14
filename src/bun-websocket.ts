type BunWebSocketConstructor = new (
  endpoint: string | URL,
  options?: Bun.WebSocketOptions,
) => WebSocket;

const WebSocketWithOptions = WebSocket as BunWebSocketConstructor;

export function createAuthenticatedWebSocket(endpoint: string, capabilityToken: string): WebSocket {
  return new WebSocketWithOptions(endpoint, {
    headers: { Authorization: `Bearer ${capabilityToken}` },
    perMessageDeflate: false,
  });
}
