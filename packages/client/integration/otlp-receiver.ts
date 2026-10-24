/** @file Disposable OTLP endpoint for Client startup configuration checks. */
import { Data, Effect } from "effect";
import { createServer, type Server } from "node:http";

/** Socket setup failures retain the cause for test diagnostics. */
class OtlpReceiverError extends Data.TaggedError("OtlpReceiverError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function listen(server: Server) {
  return Effect.async<URL, OtlpReceiverError>((resume) => {
    server.once("error", (cause) =>
      resume(
        Effect.fail(
          new OtlpReceiverError({
            message: "OTLP receiver could not listen",
            cause,
          }),
        ),
      ),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(
        address === null || typeof address === "string"
          ? Effect.fail(
              new OtlpReceiverError({
                message: "OTLP receiver exposed no TCP port",
              }),
            )
          : Effect.succeed(new URL(`http://127.0.0.1:${address.port}`)),
      );
    });
  });
}

/** Startup tests need a reachable collector without sharing cross-package fixtures. */
export const acquireOtlpReceiver = Effect.gen(function* () {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200).end();
  });
  const endpoint = yield* Effect.acquireRelease(listen(server), () =>
    Effect.async<void>((resume) => {
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    }),
  );
  return { endpoint };
});
