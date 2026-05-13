import { Command } from "@effect/cli";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { Data, Effect } from "effect";
import { getHttpUrl } from "../config.js";

class PingError extends Data.TaggedError("PingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;

const toPingError = (cause: unknown): PingError =>
  cause instanceof PingError
    ? cause
    : new PingError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const pingEffect: Effect.Effect<void, PingError> = Effect.gen(function* () {
  const baseUrl = yield* getHttpUrl;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(`${baseUrl}/health`),
  );
  if (
    response.status < HTTP_SUCCESS_MIN ||
    response.status >= HTTP_REDIRECT_MIN
  ) {
    return yield* Effect.fail(
      new PingError({
        message: `Server unreachable: HTTP ${response.status}`,
      }),
    );
  }
}).pipe(
  Effect.timeout("5 seconds"),
  Effect.provide(NodeHttpClient.layer),
  Effect.mapError(toPingError),
);

/**
 * `moltzap ping` — hit /health on the configured server URL. Exit 0 on
 * 2xx, 1 otherwise (message to stderr via the caught Error surface).
 */
export const pingCommand = Command.make("ping", {}, () =>
  pingEffect.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        console.log("Server reachable");
      }),
    ),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        console.error(`Server unreachable: ${err.message}`);
        process.exit(1);
      }),
    ),
  ),
).pipe(Command.withDescription("Check if the MoltZap server is reachable"));
