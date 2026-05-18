import { describe, expect, beforeAll, afterAll, inject } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect } from "effect";
import { registerTestAgent as registerAgent } from "@moltzap/protocol/testing";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../../../test-utils/index.js";

const it = effectIt.live;
const TYPE_STRING = "string";

let baseUrl: string;

beforeAll(() => {
  const pgHost = inject("testPgHost");
  const pgPort = inject("testPgPort");
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => startCoreTestServer({ pgHost, pgPort }),
      catch: (cause) => cause,
    }).pipe(
      Effect.tap((server) =>
        Effect.sync(() => {
          baseUrl = server.baseUrl;
        }),
      ),
    ),
  );
});

afterAll(() =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => stopCoreTestServer(),
      catch: (cause) => cause,
    }),
  ),
);

describe("Registration secret enforcement", () => {
  it("allows registration when no secret is configured (default)", () =>
    Effect.gen(function* () {
      const result = yield* registerAgent({ baseUrl, name: "open-agent" });
      expect(result.agentId).toBeDefined();
      expect(result.apiKey).toBeDefined();
    }));

  it("returns agent data on successful registration", () =>
    Effect.gen(function* () {
      const result = yield* registerAgent({
        baseUrl,
        name: "test-agent-data",
      });
      expect(typeof result.agentId).toBe(TYPE_STRING);
      expect(typeof result.apiKey).toBe(TYPE_STRING);
      expect(result.agentId.length).toBeGreaterThan(0);
    }));
});
