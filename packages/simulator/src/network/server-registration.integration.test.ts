/**
 * @file Registration trust boundary against the MoltZap server image.
 * The launcher keeps the run secret, uses it for roster identities, and
 * never gives it to participant runtimes.
 *
 * Gate: `MOLTZAP_SIM_ITEST=1`, with a container engine that can mount the
 * simulator cache directory.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertions stay in the Effect whose scope owns and releases the container */
import { dirname } from "node:path";
import {
  FetchHttpClient,
  FileSystem,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { httpBaseUrl } from "@moltzap/protocol/network";
import { agentName } from "@moltzap/protocol/testing";
import { Config, Duration, Effect, Layer, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { acquireMoltZapServer } from "./server.js";

const SIM_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_SIM_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

const RUN_TIMEOUT_MS = 1_200_000;
const HTTP_FORBIDDEN = 403;
const REGISTER_ROUTE = "/api/v1/auth/register";
const ROSTER_PARTICIPANT = agentName("roster-participant");
const hostLayer = Layer.merge(NodeContext.layer, FetchHttpClient.layer);

const verifyRegistrationBoundary = Effect.gen(function* () {
  const volumeRoot = yield* Effect.scoped(
    Effect.gen(function* () {
      const server = yield* acquireMoltZapServer({
        readyTimeout: Duration.minutes(2),
      });
      const request = yield* HttpClientRequest.post(
        new URL(REGISTER_ROUTE, httpBaseUrl(server.serverUrl)).toString(),
      ).pipe(
        HttpClientRequest.bodyJson({ name: "uncredentialed-participant" }),
      );
      const response = yield* HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.execute(request)),
      );
      yield* response.text;

      expect(response.status).toBe(HTTP_FORBIDDEN);

      const authorized = yield* server.register(ROSTER_PARTICIPANT);
      expect(authorized.agentId.length).toBeGreaterThan(0);
      expect(Redacted.isRedacted(authorized.key)).toBe(true);
      return dirname(server.messageDatabasePath);
    }),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  expect(yield* fileSystem.exists(volumeRoot)).toBe(false);
}).pipe(Effect.provide(hostLayer), Effect.orDie);

describe.skipIf(!SIM_INTEGRATION_ENABLED)(
  "MoltZap registration boundary",
  () => {
    it(
      "rejects participant identity minting without the run secret",
      () => Effect.runPromise(verifyRegistrationBoundary),
      RUN_TIMEOUT_MS,
    );
  },
);

/* eslint-enable sonarjs/assertions-in-tests -- Restore strict defaults after the scoped file-level exception. */
