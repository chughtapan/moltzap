import { describe, beforeAll, afterAll, inject, expect } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect, Exit } from "effect";
import { registerTestAgent as registerAgent } from "@moltzap/protocol/testing";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../../../test-utils/index.js";

const it = effectIt.live;

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
      const exit = yield* Effect.exit(
        registerAgent({ baseUrl, name: "open-agent" }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }));
});
