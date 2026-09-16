/** @file Container entry point for the simulator's deterministic fault peer. */
import { createServer } from "node:http";
import { NodeRuntime } from "@effect/platform-node";
import { acquireHarnessEndpoint } from "@moltzap/client";
import { Config, Deferred, Effect } from "effect";
import {
  FAULT_PEER_PORT,
  FAULT_PEER_REPLY_ENV,
  runFaultPeer,
} from "./simulator-fault-peer.mjs";

const application = Effect.gen(function* () {
  const endpointUrl = yield* Config.string("MOLTZAP_MCP_URL");
  const reply = yield* Config.string(FAULT_PEER_REPLY_ENV);
  const endpoint = yield* acquireHarnessEndpoint(new URL(endpointUrl));
  const triggered = yield* Deferred.make();
  let result;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/run") {
      Effect.runFork(Deferred.succeed(triggered, undefined));
      response.writeHead(202).end();
    } else if (request.method === "GET" && request.url === "/result") {
      if (result === undefined) response.writeHead(204).end();
      else
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(result);
    } else response.writeHead(404).end();
  });
  yield* Effect.acquireRelease(
    Effect.async((resume) => {
      const failed = (error) => resume(Effect.fail(error));
      server.once("error", failed);
      server.listen(FAULT_PEER_PORT, "0.0.0.0", () => {
        server.off("error", failed);
        resume(Effect.void);
      });
      return Effect.sync(() => server.close());
    }),
    () =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
  );
  yield* Effect.sync(() =>
    process.stdout.write("MoltZap fault peer bridge ready\n"),
  );
  yield* triggered;
  yield* runFaultPeer(endpoint, reply).pipe(
    Effect.match({
      onFailure: (error) => {
        result = JSON.stringify({ error: String(error) });
      },
      onSuccess: () => {
        result = JSON.stringify({ done: true });
      },
    }),
  );
  return yield* Effect.never;
});
NodeRuntime.runMain(Effect.scoped(application));
