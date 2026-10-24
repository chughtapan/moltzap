/** @file Disposable OTLP endpoint for Client startup configuration checks. */
import { NodeHttpServer } from "@effect/platform-node";
import { Effect } from "effect";
import { createServer } from "node:http";

/** Startup tests need a reachable collector without sharing cross-package fixtures. */
export const acquireOtlpReceiver = Effect.gen(function* () {
  const server = yield* NodeHttpServer.make(
    () =>
      createServer((request, response) => {
        request.resume();
        response.writeHead(200).end();
      }),
    { host: "127.0.0.1", port: 0 },
  );
  const address = server.address;
  if (address._tag !== "TcpAddress") {
    return yield* Effect.dieMessage("OTLP receiver exposed no TCP port");
  }
  return { endpoint: new URL(`http://127.0.0.1:${address.port}`) };
});
