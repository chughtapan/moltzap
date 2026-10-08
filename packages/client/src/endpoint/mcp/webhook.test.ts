/** @file Local Dot callback conformance through Effect's HttpClient service. */

import {
  type HttpBody,
  HttpClient,
  HttpClientResponse,
} from "@effect/platform";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Match,
  Schema,
} from "effect";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import { readRuntimeEvent } from "../../delivery/inbox.js";
import { eventIdOf } from "../../delivery/operations.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  openEndpointStore,
} from "../../store/index.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import { maximumEventBytes } from "./event-schemas.js";
import {
  isPublicWebhookAddress,
  sendWebhook,
  webhookHttpClientLayer,
} from "./event-signing.js";
import { INBOX_ITEM_EVENT } from "./names.js";
import { makeWebhookEvents } from "./webhook.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals, sonarjs/no-hardcoded-ip -- Protocol codes and deliberately unsafe IP fixtures pin the callback trust boundary. */

const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const url = "https://callback.example/events";
const input = {
  name: INBOX_ITEM_EVENT,
  arguments: {},
  cursor: null,
  delivery: { mode: "webhook", url, secret },
};
const verification = Schema.Struct({
  type: Schema.Literal("verification"),
  challenge: Schema.String,
});
const occurrence = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("item"), item: InboundItem }),
    Schema.Struct({
      kind: Schema.Literal("reference"),
      itemKind: Schema.String,
      bytes: Schema.Number,
    }),
  ),
  cursor: Schema.Null,
});
const callback = Schema.parseJson(Schema.Union(verification, occurrence));

const requestBody = (body: HttpBody.HttpBody): string =>
  Match.value(body).pipe(
    Match.tag("Uint8Array", (value) => new TextDecoder().decode(value.body)),
    Match.orElse(() => {
      throw new Error("Expected exact callback bytes");
    }),
  );

const callbackResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  decoded: typeof callback.Type,
  status: number,
  challengeValid: boolean,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      "type" in decoded
        ? JSON.stringify({
            challenge: challengeValid ? decoded.challenge : "incorrect",
          })
        : "receipt".repeat(1024),
      { status },
    ),
  );

const token = (byte: number) =>
  Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte));
const item = (text = "failed request") =>
  Schema.decodeUnknownSync(InboundItem)({
    kind: "operationFailed",
    id: digest("col_", 1),
    to: "agent:bob",
    error: text,
  });
const enqueue = (store: EndpointStore, byte: number, text?: string) =>
  encodeRuntimeValue(item(text ?? "failed request")).pipe(
    Effect.flatMap((canonicalItem) =>
      store.putInboxItem({ deliveryToken: token(byte), canonicalItem }),
    ),
  );

const fixture = (store: EndpointStore) => {
  const gate = Effect.unsafeMakeSemaphore(1);
  let status = 200;
  let challengeValid = true;
  let onEvent = Effect.void;
  const posts: Array<{
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
  }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body = requestBody(request.body);
      posts.push({ body, headers: { ...request.headers } });
      const decoded = Schema.decodeUnknownSync(callback)(body);
      if (!("type" in decoded)) {
        yield* onEvent;
      }
      return callbackResponse(request, decoded, status, challengeValid);
    }),
  );
  return {
    gate,
    store,
    client,
    posts,
    status: (value: number) => {
      status = value;
    },
    challenge: (value: boolean) => {
      challengeValid = value;
    },
    onEvent: (effect: Effect.Effect<void>) => {
      onEvent = effect;
    },
    acquire: makeWebhookEvents(store, gate).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  };
};

/** Moves the clock of a scenario that runs `onSteppedClock`. */
class SteppedClock extends Context.Tag("SteppedClock")<
  SteppedClock,
  (span: Duration.DurationInput) => Effect.Effect<void>
>() {}

/** Moves the clock of the running scenario by `span`, at once. */
const stepClock = (span: Duration.DurationInput) =>
  Effect.flatMap(SteppedClock, (step) => step(span));

/**
 * Runs `scenario` on its own clock, starting at the epoch, which only
 * `stepClock` moves. Moving a TestClock waits real timer turns until every
 * fiber suspends, and again for each sleep it passes, and every callback
 * leaves its response bound behind as a sleep, so a scenario of many
 * callbacks and moves spends seconds of a loaded machine on those waits.
 * These scenarios only read the time: this clock moves at once, and its
 * sleeps never end because a scripted callback answers before its bound.
 * @param scenario Scenario that reads and steps the clock.
 * @returns The scenario on a fresh stepped clock.
 */
const onSteppedClock = <Value, Failure>(
  scenario: Effect.Effect<Value, Failure, SteppedClock>,
): Effect.Effect<Value, Failure> =>
  Effect.suspend(() => {
    let millis = 0;
    const clock: Clock.Clock = {
      [Clock.ClockTypeId]: Clock.ClockTypeId,
      unsafeCurrentTimeMillis: () => millis,
      currentTimeMillis: Effect.sync(() => millis),
      unsafeCurrentTimeNanos: () => BigInt(millis) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
      sleep: () => Effect.never,
    };
    return scenario.pipe(
      Effect.withClock(clock),
      Effect.provideService(SteppedClock, (span) =>
        Effect.sync(() => {
          millis += Duration.toMillis(span);
        }),
      ),
    );
  });

const signsVerifiesAndRotates = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        const grant = yield* events.subscribe(input, "runtime");
        const control = test.posts[0];
        expect(control?.headers["webhook-id"]).toMatch(/^msg_verification_/u);
        const expected = createHmac("sha256", Buffer.alloc(32, 1))
          .update(
            `${control?.headers["webhook-id"]}.${control?.headers["webhook-timestamp"]}.${control?.body}`,
          )
          .digest("base64");
        expect(control?.headers["webhook-signature"]).toBe(`v1,${expected}`);
        yield* enqueue(store, 1);
        yield* events.observe();
        expect(
          Schema.decodeUnknownSync(Schema.parseJson(occurrence))(
            test.posts[1]?.body,
          ).data,
        ).toEqual({ kind: "item", item: item() });
        expect((yield* events.status).pendingCount).toBe(0);
        const rotated = {
          ...input,
          delivery: {
            ...input.delivery,
            secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
          },
        };
        expect((yield* events.subscribe(rotated, "runtime")).id).toBe(grant.id);
        test.challenge(false);
        yield* stepClock("11 minutes");
        expect(
          (yield* events.subscribe(input, "runtime").pipe(Effect.flip)).code,
        ).toBe(-32015);
        expect(
          (yield* events
            .unsubscribe({ ...input, delivery: { url } }, "owner")
            .pipe(Effect.flip)).code,
        ).toBe(-32011);
        yield* events.unsubscribe({ ...input, delivery: { url } }, "runtime");
        expect(
          (yield* readRuntimeEvent(store, eventIdOf(token(1)))).item,
        ).toEqual(item());
      }),
    ).pipe(onSteppedClock),
  );

const retainsTerminalRejections = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const status of [410, 413]) {
          const store = yield* openEndpointStore(stateDirectory());
          const test = fixture(store);
          const events = yield* test.acquire;
          yield* enqueue(store, 1);
          yield* events.subscribe(input, "runtime");
          test.status(status);
          yield* events.observe();
          expect((yield* events.status).stalled).toBe("terminal");
          const restarted = yield* test.acquire;
          test.status(200);
          yield* restarted.subscribe(input, "runtime");
          expect((yield* restarted.resume.pipe(Effect.flip)).code).toBe(-32014);
          yield* stepClock("1 day");
          yield* restarted.subscribe(input, "runtime");
          yield* restarted.observe();
          expect(test.posts).toHaveLength(4);
          expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
          yield* restarted.revoke;
          yield* restarted.subscribe(input, "runtime");
          yield* restarted.observe();
          expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
        }
      }),
    ).pipe(onSteppedClock),
  );

const verifiesRotatedSecret = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        const grant = yield* events.subscribe(input, "runtime");
        const rotated = {
          ...input,
          delivery: {
            ...input.delivery,
            secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
          },
        };
        test.challenge(false);
        expect(
          (yield* events.subscribe(rotated, "runtime").pipe(Effect.flip)).code,
        ).toBe(-32015);
        expect(test.posts).toHaveLength(2);
        test.challenge(true);
        expect((yield* events.subscribe(rotated, "runtime")).id).toBe(grant.id);
        expect(test.posts).toHaveLength(3);
        yield* events.subscribe(rotated, "runtime");
        expect(test.posts).toHaveLength(3);
      }),
    ).pipe(onSteppedClock),
  );

const permitsReadAndRevokeDuringDelivery = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        yield* enqueue(store, 1);
        yield* events.subscribe(input, "runtime");
        const entered = yield* Deferred.make<undefined>();
        const release = yield* Deferred.make<undefined>();
        test.onEvent(
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Deferred.await(release)),
            Effect.asVoid,
          ),
        );
        const delivery = yield* events.observe().pipe(Effect.fork);
        yield* Deferred.await(entered);
        expect(
          (yield* readRuntimeEvent(store, eventIdOf(token(1)))).item,
        ).toEqual(item());
        yield* events.revoke;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(delivery);
        expect((yield* events.status).mode).toBe("none");
        expect(events.hasActiveSubscription()).toBe(false);
        expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
      }),
    ),
  );

const refreshPreservesTerminalReceipt = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        yield* enqueue(store, 1);
        yield* events.subscribe(input, "runtime");
        const entered = yield* Deferred.make<undefined>();
        const release = yield* Deferred.make<undefined>();
        test.status(413);
        test.onEvent(
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Deferred.await(release)),
            Effect.asVoid,
          ),
        );
        const delivery = yield* events.observe().pipe(Effect.fork);
        yield* Deferred.await(entered);
        yield* events.subscribe(input, "runtime");
        yield* events.resume;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(delivery);
        expect((yield* events.status).stalled).toBe("terminal");
        expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
      }),
    ).pipe(onSteppedClock),
  );

const retriesAcrossRestart = () => {
  const path = stateDirectory();
  let original: string | undefined;
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          const test = fixture(store);
          const events = yield* test.acquire;
          yield* enqueue(store, 1);
          yield* events.subscribe(input, "runtime");
          test.status(503);
          yield* events.observe();
          original = test.posts[1]?.body;
          expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
        }),
      );
      yield* stepClock("3 seconds");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          const test = fixture(store);
          const events = yield* test.acquire;
          yield* events.observe();
          expect(test.posts[0]?.body).toBe(original);
          expect(test.posts[0]?.headers["webhook-id"]).toBe(
            eventIdOf(token(1)),
          );
          expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
          yield* stepClock("10 minutes");
          yield* events.observe();
          expect(test.posts).toHaveLength(1);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          expect(
            (yield* readRuntimeEvent(store, eventIdOf(token(1)))).item,
          ).toEqual(item());
        }),
      );
    }).pipe(onSteppedClock),
  );
};

const resumesExhaustedCallbacks = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        yield* enqueue(store, 1);
        yield* events.subscribe(input, "runtime");
        test.status(503);
        yield* Effect.replicateEffect(
          events.observe().pipe(Effect.zipRight(stepClock("5 minutes"))),
          99,
          { discard: true },
        );
        expect((yield* events.status).stalled).toBeNull();
        yield* events.observe();
        expect((yield* events.status).stalled).toBe("callback");
        expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
        const restarted = yield* test.acquire;
        test.status(200);
        yield* stepClock("5 minutes");
        yield* restarted.observe();
        expect(test.posts).toHaveLength(101);
        yield* restarted.resume;
        yield* restarted.observe();
        expect(test.posts).toHaveLength(102);
        expect(test.posts.at(-1)?.body).toBe(test.posts[1]?.body);
        expect((yield* events.status).pendingCount).toBe(0);
        expect((yield* restarted.status).stalled).toBeNull();
      }),
    ).pipe(onSteppedClock),
  );

const boundsPayloadAndDrains = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        const large = "世界".repeat(100_000);
        yield* enqueue(store, 1, large);
        for (let index = 2; index < 55; index += 1) {
          yield* enqueue(store, index);
        }
        yield* events.subscribe(input, "runtime");
        yield* events.observe();
        expect(test.posts).toHaveLength(55);
        const body = test.posts[1]?.body ?? "";
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maximumEventBytes);
        expect(
          Schema.decodeUnknownSync(Schema.parseJson(occurrence))(body).data
            .kind,
        ).toBe("reference");
        expect(
          (yield* readRuntimeEvent(store, eventIdOf(token(1)))).item,
        ).toEqual(item(large));
        expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
        yield* enqueue(store, 55);
        yield* stepClock("1 day");
        yield* events.observe();
        expect((yield* events.status).mode).toBe("webhook");
        expect(events.hasActiveSubscription()).toBe(false);
        expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
      }),
    ).pipe(onSteppedClock),
  );

const removesRetiredOccurrence = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(stateDirectory());
        const test = fixture(store);
        const events = yield* test.acquire;
        yield* enqueue(store, 1);
        yield* events.subscribe(input, "runtime");
        test.status(503);
        yield* events.observe();
        const canonicalItem = yield* encodeRuntimeValue(item("replacement"));
        yield* store.replaceInboxItem(token(1), {
          deliveryToken: token(2),
          canonicalItem,
        });
        const restarted = yield* test.acquire;
        test.status(200);
        yield* restarted.observe();
        expect(test.posts[2]?.headers["webhook-id"]).toBe(eventIdOf(token(2)));
        expect(
          (yield* readRuntimeEvent(store, eventIdOf(token(1)))).item,
        ).toEqual(item());
        expect(
          (yield* readRuntimeEvent(store, "evt_invalid").pipe(Effect.flip))
            .reason,
        ).toBe("invalid-event");
        expect(
          (yield* readRuntimeEvent(store, eventIdOf(token(3))).pipe(
            Effect.flip,
          )).reason,
        ).toBe("unknown-event");
      }),
    ).pipe(onSteppedClock),
  );

const rejectsUnsafeCallbacks = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "::1",
        "::ffff:127.0.0.1",
        "2001:db8::1",
        "64:ff9b::7f00:1",
      ]) {
        expect(isPublicWebhookAddress(address)).toBe(false);
      }
      expect(isPublicWebhookAddress("8.8.8.8")).toBe(true);
      expect(isPublicWebhookAddress("2606:4700:4700::1111")).toBe(true);
      const request = {
        url: "https://127.0.0.1/private",
        secret,
        messageId: "evt_test",
        subscriptionId: "sub_test",
        body: "{}",
        timestamp: 0,
      };
      const blocked = yield* sendWebhook(request).pipe(
        Effect.provide(webhookHttpClientLayer),
        Effect.flip,
      );
      expect(blocked.reason).toBe("connection_refused");
      const dnsBlocked = yield* sendWebhook({
        ...request,
        url: "https://localhost/private",
      }).pipe(Effect.provide(webhookHttpClientLayer), Effect.flip);
      expect(dnsBlocked.reason).toBe("connection_refused");
      const test = fixture(yield* openEndpointStore(stateDirectory()));
      test.status(302);
      const events = yield* test.acquire;
      expect(
        (yield* events.subscribe(input, "runtime").pipe(Effect.flip)).code,
      ).toBe(-32015);
      expect(test.posts).toHaveLength(1);
      expect(events.hasActiveSubscription()).toBe(false);
    }).pipe(Effect.scoped),
  );

// @agent-code-guard/regression-only: these transcripts pin the external MCP draft, callback signatures, crash recovery and trust boundary.
describe("local Dot webhook conformance", () => {
  it(
    "verifies a rotated secret before caching its challenge",
    verifiesRotatedSecret,
  );
  it(
    "retains exhausted callbacks until owner resume retries the same event",
    resumesExhaustedCallbacks,
  );
  it(
    "preserves a terminal response during concurrent refresh and resume",
    refreshPreservesTerminalReceipt,
  );
  it(
    "discards a retired occurrence while preserving its immutable read result",
    removesRetiredOccurrence,
  );
  it(
    "retains terminally rejected items across restart and refresh",
    retainsTerminalRejections,
  );
  it(
    "allows callback inbox reads and ignores a receipt after owner revocation",
    permitsReadAndRevokeDuringDelivery,
  );
  it(
    "verifies signed callbacks, rotates secrets and enforces the subscription principal",
    signsVerifiesAndRotates,
  );
  it(
    "retries exact event bytes after database reopen and retires only on receipt",
    retriesAcrossRestart,
  );
  it(
    "bounds complete envelopes, retains referenced payloads and drains beyond one page",
    boundsPayloadAndDrains,
  );
  it(
    "rejects private destinations, DNS to loopback and redirects through Effect HttpClient",
    rejectsUnsafeCallbacks,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals, sonarjs/no-hardcoded-ip -- Restore repository defaults. */
