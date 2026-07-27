/**
 * @file Raw TCP relay behind the World's per-agent proxied endpoints.
 * Deliberately plain `node:net` (isolated here the way `node-http.ts`
 * isolates the http factory): a connection-level sever IS
 * `socket.destroy()`, and the raw API keeps teardown synchronous and
 * free of cross-scope finalizer waits. WS runs over TCP, so the byte
 * relay carries the protocol unchanged.
 */
import * as net from "node:net";

export type RelayProxy = {
  readonly port: number;
  sever(): void;
  heal(): void;
  close(): void;
};

/** Raw echo dialer for relay tests: connect, write once, stream data out; the returned thunk closes. */
export function dialForEcho(
  port: number,
  payload: string,
  onData: (text: string) => void,
): () => void {
  const socket = net.connect({ host: "127.0.0.1", port }, () => {
    socket.write(payload);
  });
  socket.on("data", (chunk) => {
    onData(chunk.toString("utf8"));
  });
  socket.on("error", () => {
    socket.destroy();
  });
  return () => {
    socket.destroy();
  };
}

function relayOne(
  state: { readonly severed: boolean },
  live: Set<net.Socket>,
  client: net.Socket,
  target: { readonly host: string; readonly port: number },
): void {
  if (state.severed) {
    client.destroy();
    return;
  }
  const upstream = net.connect(target);
  live.add(client);
  live.add(upstream);
  const drop = (): void => {
    client.destroy();
    upstream.destroy();
    live.delete(client);
    live.delete(upstream);
  };
  client.on("error", drop);
  upstream.on("error", drop);
  client.on("close", drop);
  upstream.on("close", drop);
  client.pipe(upstream);
  upstream.pipe(client);
}

export function createRelayProxy(
  upstreamHost: string,
  upstreamPort: number,
  onReady: (proxy: RelayProxy) => void,
  onError: (cause: Error) => void,
): void {
  const state = { severed: false };
  const live = new Set<net.Socket>();
  const server = net.createServer((client) => {
    relayOne(state, live, client, { host: upstreamHost, port: upstreamPort });
  });
  server.on("error", onError);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      onError(new Error("relay proxy bound without a TCP address"));
      return;
    }
    onReady({
      port: address.port,
      sever: () => {
        state.severed = true;
        for (const socket of live) socket.destroy();
        live.clear();
      },
      heal: () => {
        state.severed = false;
      },
      close: () => {
        for (const socket of live) socket.destroy();
        live.clear();
        server.close();
      },
    });
  });
}
