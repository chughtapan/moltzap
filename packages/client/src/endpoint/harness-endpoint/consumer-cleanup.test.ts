/** @file Scoped remote cleanup deadlines must interrupt a stalled SDK request while preserving local teardown. */

import { Client } from "@modelcontextprotocol/client";
import {
  Deferred,
  Effect,
  Fiber,
  Schema,
  Stream,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it, vi } from "vitest";
import { HARNESS_CONSUMER_META_KEY } from "../mcp/names.js";
import { pollWakeups } from "./poll.js";
import { acquireCallbackServer } from "./webhook-http.js";
import { webhookMessages } from "./webhook.js";

const generation = "00000000-0000-4000-8000-000000000001";
const releaseRequest = Schema.is(
  Schema.Struct({
    _meta: Schema.Struct({
      [HARNESS_CONSUMER_META_KEY]: Schema.Struct({
        release: Schema.Literal(true),
      }),
    }),
  }),
);
const client = () =>
  new Client({ name: "bounded-cleanup-fixture", version: "1" });

interface CleanupObservation {
  readonly entered: Deferred.Deferred<undefined>;
  aborted: boolean;
}

describe("native consumer shutdown", () => {
  it(
    "aborts stalled poll release at its deadline inside the stream finalizer",
    boundsPollRelease,
  );
  it(
    "fences and releases the callback port after a stalled unsubscribe deadline",
    boundsWebhookRelease,
  );
});

function boundsPollRelease() {
  return Effect.gen(function* () {
    const sdk = client();
    const observation = yield* cleanupObservation();
    const request = vi.spyOn(sdk, "request");
    request.mockResolvedValueOnce({
      events: [],
      cursor: "fixture-cursor",
      truncated: false,
      hasMore: false,
      nextPollMs: 1000,
      _meta: { [HARNESS_CONSUMER_META_KEY]: { generation } },
    });
    request.mockImplementation((...parameters) =>
      stalledRequest(
        observation,
        releaseRequest(parameters[0].params),
        parameters[2]?.signal,
      ),
    );
    const listener = yield* pollWakeups(sdk).pipe(
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Deferred.await(observation.entered);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(listener);
    expect(observation.aborted).toBe(true);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "events/poll",
      params: {
        _meta: { [HARNESS_CONSUMER_META_KEY]: { generation, release: true } },
      },
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );
}

function boundsWebhookRelease() {
  return Effect.gen(function* () {
    const sdk = client();
    const observation = yield* cleanupObservation();
    const ready = yield* Deferred.make<undefined>();
    const port = yield* Effect.scoped(callbackPort());
    vi.spyOn(sdk, "request")
      .mockResolvedValueOnce({
        id: "owned-subscription",
        refreshBefore: new Date(Date.now() + 60_000).toISOString(),
        cursor: null,
        truncated: false,
      })
      .mockImplementation((...parameters) =>
        stalledRequest(
          observation,
          parameters[0].method === "events/unsubscribe",
          parameters[2]?.signal,
        ),
      );
    const listener = yield* webhookMessages(sdk, {
      mode: "webhook",
      url: "https://native.example/events",
      port,
      onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
    }).pipe(Stream.runDrain, Effect.forkScoped);
    yield* Deferred.await(ready);
    const closing = yield* Fiber.interrupt(listener).pipe(Effect.forkScoped);
    yield* Deferred.await(observation.entered);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(closing);
    expect(observation.aborted).toBe(true);
    expect(yield* callbackPort(port)).toBe(port);
  }).pipe(
    Effect.scoped,
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );
}

function cleanupObservation() {
  return Deferred.make<undefined>().pipe(
    Effect.map((entered): CleanupObservation => ({ entered, aborted: false })),
  );
}

function callbackPort(port = 0) {
  return acquireCallbackServer({
    port,
    path: "/events",
    handle: () => Effect.dieMessage("cleanup fixture receives no webhook work"),
  });
}

/** The SDK mock retains its request until the caller's AbortSignal fires; no wall-clock delay is substituted. */
function stalledRequest(
  observation: CleanupObservation,
  releasing: boolean,
  signal?: AbortSignal,
) {
  return Effect.async<never>((resume) => {
    if (signal === undefined) {
      resume(Effect.dieMessage("SDK cleanup requires an abort signal"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        if (releasing) {
          observation.aborted = true;
        }
        resume(Effect.dieMessage("fixture SDK request aborted"));
      },
      { once: true },
    );
    if (releasing) {
      Effect.runSync(Deferred.succeed(observation.entered, undefined));
    }
  }).pipe(Effect.runPromise);
}
