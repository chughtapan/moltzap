import { Command } from "@effect/cli";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { Effect } from "effect";
import { getHttpUrl } from "../config.js";

const pingEffect: Effect.Effect<void, Error> = Effect.gen(function* () {
  const baseUrl = yield* getHttpUrl;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(`${baseUrl}/health`),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new Error(`Server unreachable: HTTP ${response.status}`),
    );
  }
}).pipe(
  Effect.timeout("5 seconds"),
  Effect.provide(NodeHttpClient.layer),
  Effect.catchAll((err) =>
    Effect.fail(err instanceof Error ? err : new Error(String(err))),
  ),
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
