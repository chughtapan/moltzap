/**
 * @file Registration trust boundary against the MoltZap server image.
 * The launcher keeps the run secret, uses it for roster identities, and
 * never gives it to participant runtimes.
 *
 * Gate: `MOLTZAP_SIM_ITEST=1`, with a container engine that can mount the
 * simulator cache directory.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertions execute inside the scoped Effect so the container is always released */
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { AgentName } from "@moltzap/protocol/identity";
import { httpBaseUrl } from "@moltzap/protocol/network";
import { Config, Duration, Effect, Layer, Redacted, Schema } from "effect";
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
const ROSTER_PARTICIPANT = Schema.decodeSync(AgentName)("roster-participant");
const HostLayer = Layer.merge(NodeContext.layer, FetchHttpClient.layer);

const verifyRegistrationBoundary = Effect.scoped(
  Effect.gen(function* () {
    const server = yield* acquireMoltZapServer({
      readyTimeout: Duration.minutes(2),
    });
    const request = yield* HttpClientRequest.post(
      new URL(REGISTER_ROUTE, httpBaseUrl(server.serverUrl)).toString(),
    ).pipe(HttpClientRequest.bodyJson({ name: "uncredentialed-participant" }));
    const response = yield* HttpClient.HttpClient.pipe(
      Effect.flatMap((client) => client.execute(request)),
    );
    yield* response.text;

    expect(response.status).toBe(HTTP_FORBIDDEN);

    const authorized = yield* server.register(ROSTER_PARTICIPANT);
    expect(authorized.agentId.length).toBeGreaterThan(0);
    expect(Redacted.isRedacted(authorized.key)).toBe(true);
  }),
).pipe(Effect.provide(HostLayer), Effect.orDie);

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
