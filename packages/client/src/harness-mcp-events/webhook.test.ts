/** @file Local Dot callback conformance through Effect's HttpClient service. */

import {
  type HttpBody,
  HttpClient,
  HttpClientResponse,
} from "@effect/platform";
import {
  Deferred,
  Effect,
  Match,
  Schema,
  TestClock,
  TestContext,
} from "effect";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EndpointStore } from "../endpoint/store.js";
import { INBOX_PENDING_EVENT } from "../harness-mcp-contract.js";
import {
  isPublicWebhookAddress,
  sendWebhook,
  webhookHttpClientLayer,
} from "./http.js";
import { makeHarnessEvents } from "./index.js";
import { makeWebhookEvents } from "./webhook.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals, sonarjs/no-hardcoded-ip -- Protocol codes and deliberately unsafe IP fixtures pin the callback trust boundary. */

const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const url = "https://callback.example/events";
const input = {
  name: INBOX_PENDING_EVENT,
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
  data: Schema.Struct({ pendingCount: Schema.Number }),
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

const fixture = () => {
  const gate = Effect.unsafeMakeSemaphore(1);
  let bytes: Uint8Array | undefined;
  let status = 200;
  let challengeValid = true;
  let onEvent = Effect.void;
  const posts: Array<{
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
  }> = [];
  const store: Pick<EndpointStore, "readEventState" | "writeEventState"> = {
    readEventState: () => Effect.succeed(bytes),
    writeEventState: (value) =>
      Effect.sync(() => {
        bytes = value;
      }),
  };
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

const signsVerifiesAndRotates = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const test = fixture();
      const events = yield* test.acquire;
      const grant = yield* events.subscribe(input, "runtime");
      const control = test.posts[0];
      expect(control?.headers["webhook-id"]).toMatch(/^msg_verification_/u);
      expect(control?.headers["x-mcp-subscription-id"]).toBe(grant.id);
      const expected = createHmac("sha256", Buffer.alloc(32, 1))
        .update(
          `${control?.headers["webhook-id"]}.${control?.headers["webhook-timestamp"]}.${control?.body}`,
        )
        .digest("base64");
      expect(control?.headers["webhook-signature"]).toBe(`v1,${expected}`);
      yield* events.observe({ pendingCount: 2, newestSequence: 2 });
      expect(test.posts).toHaveLength(2);
      expect(
        Schema.decodeUnknownSync(Schema.parseJson(occurrence))(
          test.posts[1]?.body,
        ).data.pendingCount,
      ).toBe(2);
      expect((yield* events.status).pendingCount).toBe(2);
      const rotated = {
        ...input,
        delivery: {
          ...input.delivery,
          secret: `whsec_${Buffer.alloc(32, 2).toString("base64")}`,
        },
      };
      expect((yield* events.subscribe(rotated, "runtime")).id).toBe(grant.id);
      expect(test.posts).toHaveLength(2);
      test.challenge(false);
      expect((yield* events.subscribe(input, "runtime")).id).toBe(grant.id);
      expect(test.posts).toHaveLength(2);
      yield* TestClock.adjust("11 minutes");
      expect(
        (yield* events.subscribe(input, "runtime").pipe(Effect.flip)).code,
      ).toBe(-32015);
      expect((yield* events.status).mode).toBe("webhook");
      expect(
        (yield* events
          .unsubscribe({ ...input, delivery: { url } }, "owner")
          .pipe(Effect.flip)).code,
      ).toBe(-32011);
      yield* events.unsubscribe({ ...input, delivery: { url } }, "runtime");
      expect(events.hasActiveSubscription()).toBe(false);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const discardsRejectedOccurrences = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const status of [410, 413]) {
        const test = fixture();
        const events = yield* test.acquire;
        yield* events.subscribe(input, "runtime");
        test.status(status);
        yield* events.observe({ pendingCount: 1, newestSequence: 1 });
        const rejected = test.posts[1]?.headers["webhook-id"];
        yield* TestClock.adjust("3 seconds");
        yield* events.observe({ pendingCount: 1, newestSequence: 1 });
        expect(test.posts).toHaveLength(2);
        expect(events.hasActiveSubscription()).toBe(true);
        expect((yield* events.status).stalled).toBeNull();
        test.status(200);
        yield* events.observe({ pendingCount: 2, newestSequence: 2 });
        expect(test.posts).toHaveLength(3);
        expect(test.posts[2]?.headers["webhook-id"]).not.toBe(rejected);
        expect((yield* events.status).pendingCount).toBe(2);
      }
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const permitsReadAndRevokeDuringDelivery = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const test = fixture();
        const events = yield* test.acquire;
        yield* events.subscribe(input, "runtime");
        const entered = yield* Deferred.make<undefined>();
        const release = yield* Deferred.make<undefined>();
        const hub = yield* makeHarnessEvents({
          gate: test.gate,
          registered: () => true,
          summary: () => Effect.succeed({ pendingCount: 1, newestSequence: 1 }),
          webhook: events,
        });
        yield* Effect.addFinalizer(() => hub.close);
        test.onEvent(
          hub.inboxRead.pipe(
            Effect.orDie,
            Effect.zipRight(Deferred.succeed(entered, undefined)),
            Effect.zipRight(Deferred.await(release)),
          ),
        );
        hub.notifyPending();
        yield* Deferred.await(entered);
        expect((yield* hub.status).pendingCount).toBe(1);
        yield* hub.revoke;
        yield* Deferred.succeed(release, undefined);
        yield* events.observe({ pendingCount: 0, newestSequence: 1 });
        expect(events.hasActiveSubscription()).toBe(false);
        expect((yield* events.status).mode).toBe("none");
      }),
    ),
  );

const retriesAcrossRestart = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const test = fixture();
      const first = yield* test.acquire;
      const grant = yield* first.subscribe(input, "runtime");
      test.status(503);
      yield* first.observe({ pendingCount: 1, newestSequence: 1 });
      const original = test.posts[1];
      if (original === undefined) {
        return yield* Effect.dieMessage("Missing callback attempt");
      }
      const restarted = yield* test.acquire;
      expect((yield* restarted.status).id).toBe(grant.id);
      test.status(200);
      yield* TestClock.adjust("3 seconds");
      yield* restarted.observe({ pendingCount: 1, newestSequence: 1 });
      expect(test.posts[2]?.body).toBe(original.body);
      expect(test.posts[2]?.headers["webhook-id"]).toBe(
        original.headers["webhook-id"],
      );
      expect(test.posts[2]?.headers["webhook-timestamp"]).not.toBe(
        original.headers["webhook-timestamp"],
      );
      expect((yield* restarted.status).pendingCount).toBe(1);
      yield* TestClock.adjust("4 minutes");
      yield* restarted.inboxRead;
      yield* TestClock.adjust("2 minutes");
      yield* restarted.observe({ pendingCount: 1, newestSequence: 1 });
      expect(test.posts).toHaveLength(3);
      yield* TestClock.adjust("3 minutes");
      yield* restarted.observe({ pendingCount: 1, newestSequence: 1 });
      expect(test.posts[3]?.headers["webhook-id"]).not.toBe(
        original.headers["webhook-id"],
      );
      yield* restarted.observe({ pendingCount: 0, newestSequence: 1 });
      yield* TestClock.adjust("10 minutes");
      yield* restarted.observe({ pendingCount: 0, newestSequence: 1 });
      expect(test.posts).toHaveLength(4);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const boundsRemindersAndLease = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const test = fixture();
      const events = yield* test.acquire;
      yield* events.subscribe(input, "runtime");
      yield* events.observe({ pendingCount: 1, newestSequence: 1 });
      for (let index = 0; index < 7; index += 1) {
        yield* TestClock.adjust("5 minutes");
        yield* events.observe({ pendingCount: 1, newestSequence: 1 });
      }
      expect(test.posts).toHaveLength(8);
      expect((yield* events.status).stalled).toBe("unhandled");
      yield* events.observe({ pendingCount: 2, newestSequence: 2 });
      expect((yield* events.status).stalled).toBeNull();
      expect(test.posts).toHaveLength(9);
      yield* TestClock.adjust("1 day");
      yield* events.observe({ pendingCount: 2, newestSequence: 2 });
      expect(events.hasActiveSubscription()).toBe(false);
      expect((yield* events.status).mode).toBe("none");
    }).pipe(Effect.provide(TestContext.TestContext)),
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
      const test = fixture();
      test.status(302);
      const events = yield* test.acquire;
      expect(
        (yield* events.subscribe(input, "runtime").pipe(Effect.flip)).code,
      ).toBe(-32015);
      expect(test.posts).toHaveLength(1);
      expect(events.hasActiveSubscription()).toBe(false);
    }),
  );

// @agent-code-guard/regression-only: these transcripts pin the external MCP draft, callback signatures, crash recovery and trust boundary.
describe("local Dot webhook conformance", () => {
  it(
    "abandons HTTP 410 and 413 occurrences without revoking the consumer",
    discardsRejectedOccurrences,
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
    "retries exact event bytes after restart and keeps receipt separate from acknowledgment",
    retriesAcrossRestart,
  );
  it(
    "bounds no-progress reminders and expires stale registration",
    boundsRemindersAndLease,
  );
  it(
    "rejects private destinations, DNS to loopback and redirects through Effect HttpClient",
    rejectsUnsafeCallbacks,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals, sonarjs/no-hardcoded-ip -- Restore repository defaults. */
