/** @file Real inbox persistence and controlled clocks pin polling, receipt and consumer lifecycle laws. */

import {
  Effect,
  FastCheck,
  Schema,
  type Scope,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import { digest } from "../../../__tests__/agent-card-fixtures.js";
import { stateDirectory } from "../../../__tests__/store-schema-fixtures.js";
import { eventIdOf } from "../../../delivery/operations.js";
import {
  DeliveryToken,
  encodeRuntimeValue,
  EndpointStoreError,
  openEndpointStore,
} from "../../../store/index.js";
import { InboundItem } from "../../../transport/collectives/inbound.js";
import { HARNESS_CONSUMER_META_KEY, INBOX_ITEM_EVENT } from "../names.js";
import { makeHarnessPollEvents } from "./poll.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- External protocol codes, closed lifecycle errors and retained inbox counts are conformance expectations. */

const input = { name: INBOX_ITEM_EVENT, arguments: {}, cursor: null };
const token = (byte: number) =>
  Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte));
const item = (text: string) =>
  Schema.decodeUnknownSync(InboundItem)({
    kind: "operationFailed",
    id: digest("col_", 1),
    to: "agent:bob",
    error: text,
  });
const acquireFixture = Effect.gen(function* () {
  const store = yield* openEndpointStore(stateDirectory());
  const gate = yield* Effect.makeSemaphore(1);
  const poll = yield* makeHarnessPollEvents(store, gate);
  const add = (byte: number, text?: string) =>
    encodeRuntimeValue(item(text ?? `item ${String(byte)}`)).pipe(
      Effect.flatMap((canonicalItem) =>
        store.putInboxItem({ deliveryToken: token(byte), canonicalItem }),
      ),
    );
  return { store, poll, gate, add };
});
type Fixture = Effect.Effect.Success<typeof acquireFixture>;
type PollResult = Effect.Effect.Success<ReturnType<Fixture["poll"]["poll"]>>;
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));
const bootstrap = (fixture: Fixture) =>
  fixture.poll.poll(input, {}, Effect.void);
const next = (fixture: Fixture, result: PollResult, maxEvents = 50) =>
  fixture.poll.poll(
    { ...input, cursor: result.cursor, maxEvents },
    result._meta,
    Effect.void,
  );
const receipt = (fixture: Fixture, result: PollResult, byte: number) =>
  fixture.poll.nativeOperation(
    result._meta,
    fixture.store.acknowledgeInboxItem(token(byte)),
  );

const recoversUnreadAtNow = (cursor?: null) =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      yield* fixture.add(1);
      const started = yield* fixture.poll.poll(
        {
          name: INBOX_ITEM_EVENT,
          arguments: {},
          ...(cursor === undefined ? {} : { cursor }),
        },
        {},
        Effect.void,
      );
      expect(started.events).toEqual([]);
      expect(started.truncated).toBe(false);
      const pending = yield* fixture.poll.nativeOperation(
        started._meta,
        fixture.store.readInbox(),
      );
      expect(pending.items.map((entry) => entry.deliveryToken)).toEqual([
        token(1),
      ]);
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
    }),
  );

const doesNotAcknowledgeCursors = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      const started = yield* bootstrap(fixture);
      yield* fixture.add(1);
      const first = yield* next(fixture, started);
      expect(first.events).toMatchObject([
        {
          eventId: eventIdOf(token(1)),
          data: { kind: "item", item: item("item 1") },
        },
      ]);
      const replay = yield* next(fixture, started);
      expect(replay.events.map((event) => event.eventId)).toEqual(
        first.events.map((event) => event.eventId),
      );
      const quiet = yield* next(fixture, first);
      expect(quiet.events).toEqual([]);
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
      yield* receipt(fixture, first, 1);
      yield* receipt(fixture, first, 1);
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(0);
    }),
  );

const referencesLargeContent = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      const started = yield* bootstrap(fixture);
      yield* fixture.add(1, "界".repeat(100_000));
      const delivered = yield* next(fixture, started);
      expect(delivered.events).toMatchObject([
        {
          eventId: eventIdOf(token(1)),
          data: { kind: "reference", itemKind: "operationFailed" },
        },
      ]);
      expect(JSON.stringify(delivered).length).toBeLessThan(1000);
      expect(
        (yield* fixture.store.readInboxItem(token(1)))?.canonicalItem
          .byteLength,
      ).toBeGreaterThan(256 * 1024);
    }),
  );

const fencesReplacement = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      const old = yield* bootstrap(fixture);
      yield* fixture.add(1);
      yield* fixture.poll.revoke;
      const replacement = yield* bootstrap(fixture);
      expect(replacement._meta).not.toEqual(old._meta);
      const stale = yield* receipt(fixture, old, 1).pipe(Effect.flip);
      expect(stale).toMatchObject({
        code: -32012,
        data: { reason: "consumer-revoked" },
      });
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
      const stalePoll = yield* next(fixture, old).pipe(Effect.flip);
      expect(stalePoll).toMatchObject({ code: -32012 });
      yield* receipt(fixture, replacement, 1);
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(0);
    }),
  );

const expiresAndRenews = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* acquireFixture;
        const started = yield* bootstrap(fixture);
        yield* TestClock.adjust("45 seconds");
        const renewed = yield* next(fixture, started);
        yield* TestClock.adjust("45 seconds");
        expect(fixture.poll.hasActiveSubscription()).toBe(true);
        yield* next(fixture, renewed);
        yield* TestClock.adjust("61 seconds");
        expect(fixture.poll.hasActiveSubscription()).toBe(false);
        const expired = yield* next(fixture, renewed).pipe(Effect.flip);
        expect(expired).toMatchObject({ code: -32012 });
        const replacement = yield* bootstrap(fixture);
        expect(replacement._meta).not.toEqual(started._meta);
      }),
    ).pipe(Effect.provide(TestContext.TestContext)),
  );

const releasesExplicitly = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      const started = yield* bootstrap(fixture);
      yield* fixture.add(1);
      yield* fixture.poll.poll(
        input,
        {
          [HARNESS_CONSUMER_META_KEY]: {
            ...started._meta[HARNESS_CONSUMER_META_KEY],
            release: true,
          },
        },
        Effect.void,
      );
      expect(fixture.poll.hasActiveSubscription()).toBe(false);
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
      const replacement = yield* bootstrap(fixture);
      const stale = yield* receipt(fixture, started, 1).pipe(Effect.flip);
      expect(stale).toMatchObject({ code: -32012 });
      yield* receipt(fixture, replacement, 1);
    }),
  );

const returnsGapNotError = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      const started = yield* bootstrap(fixture);
      yield* fixture.add(1);
      const gap = yield* fixture.poll.poll(
        { ...input, cursor: "expired-or-foreign-cursor" },
        started._meta,
        Effect.void,
      );
      expect(gap).toMatchObject({
        events: [],
        truncated: true,
        hasMore: false,
      });
      expect(gap.cursor).not.toBe("expired-or-foreign-cursor");
      expect(
        (yield* fixture.poll.nativeOperation(
          gap._meta,
          fixture.store.readInbox(),
        )).items,
      ).toHaveLength(1);
    }),
  );

const fencesRestart = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      const old = yield* bootstrap(fixture);
      yield* fixture.add(1);
      const restarted = yield* makeHarnessPollEvents(
        fixture.store,
        fixture.gate,
      );
      const stale = yield* restarted
        .nativeOperation(
          old._meta,
          fixture.store.acknowledgeInboxItem(token(1)),
        )
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ code: -32012 });
      const recovered = yield* restarted.poll(input, {}, Effect.void);
      expect(recovered._meta).not.toEqual(old._meta);
      expect(
        (yield* restarted.nativeOperation(
          recovered._meta,
          fixture.store.readInbox(),
        )).items,
      ).toHaveLength(1);
    }),
  );

const rejectsMissingOrMalformedBinding = (metadata: unknown, code: number) =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      yield* bootstrap(fixture);
      yield* fixture.add(1);
      const refused = yield* fixture.poll
        .nativeOperation(metadata, fixture.store.acknowledgeInboxItem(token(1)))
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code });
      expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(1);
    }),
  );

const releasesFailedBootstrap = () =>
  run(
    Effect.gen(function* () {
      const fixture = yield* acquireFixture;
      let failNext = true;
      const polling = yield* makeHarnessPollEvents(
        {
          ...fixture.store,
          readInboxSummary: () =>
            Effect.suspend(() => {
              if (failNext) {
                failNext = false;
                return Effect.fail(
                  new EndpointStoreError({ reason: "persistence" }),
                );
              }
              return fixture.store.readInboxSummary();
            }),
        },
        fixture.gate,
      );
      const failed = yield* polling
        .poll(input, {}, Effect.void)
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ code: -32603 });
      expect(polling.hasActiveSubscription()).toBe(false);
      yield* polling.poll(input, {}, Effect.void);
      expect(polling.hasActiveSubscription()).toBe(true);
    }),
  );

const paginatesWithoutAcceptance = () =>
  FastCheck.assert(
    FastCheck.asyncProperty(
      FastCheck.integer({ min: 1, max: 12 }),
      FastCheck.integer({ min: 1, max: 5 }),
      (count, limit) =>
        run(
          Effect.gen(function* () {
            const fixture = yield* acquireFixture;
            let position = yield* bootstrap(fixture);
            const bytes = [...Array.from({ length: count }).keys()].map(
              (index) => index + 1,
            );
            yield* Effect.forEach(bytes, (byte) => fixture.add(byte), {
              concurrency: 1,
            });
            const observed: string[] = [];
            do {
              position = yield* next(fixture, position, limit);
              expect(position.events.length).toBeLessThanOrEqual(limit);
              observed.push(...position.events.map((event) => event.eventId));
            } while (position.hasMore);
            expect(observed).toEqual(
              bytes.map((byte) => eventIdOf(token(byte))),
            );
            expect((yield* fixture.store.readInboxSummary()).pendingCount).toBe(
              count,
            );
          }),
        ),
    ),
    { numRuns: 20 },
  );

describe("draft polling and native receipt lifecycle", () => {
  it(
    "rolls back an unreported generation when bootstrap persistence fails",
    releasesFailedBootstrap,
  );
  it.each([null, undefined])(
    "starts at now with cursor %j and recovers retained unread items",
    recoversUnreadAtNow,
  );
  it(
    "advances cursors without acceptance and retains stable event IDs",
    doesNotAcknowledgeCursors,
  );
  it(
    "uses retained references without truncating large content",
    referencesLargeContent,
  );
  it("fences late work after revocation and replacement", fencesReplacement);
  it(
    "renews the lease and requires explicit reacquisition after expiry",
    expiresAndRenews,
  );
  it("releases a generation without retiring unread work", releasesExplicitly);
  it("returns a fresh truncated cursor for replay gaps", returnsGapNotError);
  it(
    "fences old generations after daemon restart while retaining unread work",
    fencesRestart,
  );
  it("rejects missing metadata before a receipt operation runs", () =>
    rejectsMissingOrMalformedBinding({}, -32012));
  it("rejects malformed metadata before a receipt operation runs", () =>
    rejectsMissingOrMalformedBinding(
      { [HARNESS_CONSUMER_META_KEY]: { generation: "not-a-generation" } },
      -32602,
    ));
  it(
    "generates bounded pages without allowing cursor advancement to acknowledge",
    paginatesWithoutAcceptance,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
