/** @file Exercises classified delivery durability and loss of request context. */

import { Effect, Array as EffectArray, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import { runTrace } from "../__tests__/run-trace.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";
import { DeliveryToken, openEndpointStore } from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import {
  persistInboxItem,
  readRuntimeInbox,
  recoverRuntimeInbox,
} from "./inbox.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Durable tombstone and snapshot fixtures pin exact store outcomes. */

const token = (byte: number) =>
  Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte));
const failure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 1),
  to: "agent:bob",
  error: "request unavailable",
});
const request = Schema.decodeUnknownSync(InboundItem)({
  kind: "collectiveRequest",
  op: "all_gather",
  id: digest("col_", 2),
  postId: digest("pst_", 2),
  from: "agent:bob",
  to: "group:alice,bob,carol",
  question: "Answer independently",
  requestedSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
  deadlineAt: 4_000_000_000_000,
});

const preservesTokenBindings = () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        yield* persistInboxItem(store, {
          deliveryToken: token(1),
          item: failure,
        });
        yield* store.acknowledgeInboxItem(token(1));
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        yield* store.acknowledgeInboxItem(token(1));
        yield* persistInboxItem(store, {
          deliveryToken: token(1),
          item: failure,
        });
        expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
        const changed = yield* persistInboxItem(store, {
          deliveryToken: token(1),
          item: request,
        }).pipe(Effect.flip);
        expect(changed.reason).toBe("conflict");
      }),
    );
  });
};

const storeRequestAndFailure = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      yield* persistInboxItem(store, {
        deliveryToken: token(1),
        item: failure,
      });
      yield* persistInboxItem(store, {
        deliveryToken: token(2),
        item: request,
      });
    }),
  );

const retiresLostRequests = () => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* storeRequestAndFailure(path);
    const recoveredToken = yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        yield* recoverRuntimeInbox(store);
        const page = yield* readRuntimeInbox(store, {});
        expect(page.items).toHaveLength(2);
        expect(page.items[0]).toEqual({
          deliveryToken: token(1),
          item: failure,
        });
        const lost = page.items[1];
        expect(lost?.deliveryToken).not.toBe(token(2));
        expect(lost?.item).toMatchObject({
          kind: "operationFailed",
          id: digest("col_", 2),
          to: "group:alice,bob,carol",
        });
        yield* store.acknowledgeInboxItem(token(2));
        return lost?.deliveryToken;
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        yield* recoverRuntimeInbox(store);
        const page = yield* readRuntimeInbox(store, {});
        expect(page.items).toHaveLength(2);
        expect(page.items[1]?.deliveryToken).toBe(recoveredToken);
      }),
    );
  });
};

const freezesPagesAcrossArrivalsAndAcknowledgments = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(stateDirectory());
      yield* Effect.forEach(
        EffectArray.range(1, 51),
        (index) =>
          persistInboxItem(store, {
            deliveryToken: token(index),
            item: failure,
          }),
        { concurrency: 1, discard: true },
      );
      const first = yield* readRuntimeInbox(store, {});
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toBeDefined();
      yield* persistInboxItem(store, {
        deliveryToken: token(52),
        item: failure,
      });
      yield* store.acknowledgeInboxItem(token(1));
      const second = yield* readRuntimeInbox(store, {
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.deliveryToken)).toEqual([
        token(51),
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect((yield* store.readInboxSummary()).pendingCount).toBe(51);
      const invalid = yield* readRuntimeInbox(store, {
        cursor: "invalid",
      }).pipe(Effect.flip);
      expect(invalid.reason).toBe("invalid-continuation");
    }),
  );

const commitsReceiptAtomically = () => {
  const path = stateDirectory();
  const state = new TextEncoder().encode('{"registration":null}');
  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        yield* persistInboxItem(store, {
          deliveryToken: token(1),
          item: failure,
        });
        yield* store.writeEventState(state);
        const error = yield* store
          .completeWebhookDelivery(token(1), new Uint8Array())
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-input");
        expect((yield* store.readInboxSummary()).pendingCount).toBe(1);
        expect(yield* store.readEventState()).toEqual(state);
        const next = new TextEncoder().encode(
          '{"registration":{"outbox":null}}',
        );
        yield* store.completeWebhookDelivery(token(1), next);
        expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
        expect(yield* store.readEventState()).toEqual(next);
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(path);
        expect((yield* store.readInboxItem(token(1)))?.acknowledged).toBe(true);
        expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
      }),
    );
  });
};

describe("durable runtime inbox", () => {
  it(
    "rolls back a failed receipt commit and retains a successful retirement across reopen",
    runTrace(commitsReceiptAtomically),
  );
  it(
    "retains acknowledgment tombstones and rejects token payload collisions",
    runTrace(preservesTokenBindings),
  );
  it(
    "replaces a lost request with one stable, separately identified failure",
    runTrace(retiresLostRequests),
  );
  it(
    "bounds a snapshot while new arrivals and acknowledgments change unread state",
    runTrace(freezesPagesAcrossArrivalsAndAcknowledgments),
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
