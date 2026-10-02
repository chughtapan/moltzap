/** @file Exercises classified delivery durability and loss of request context. */

import { Effect, Encoding, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These persistence tests reopen real SQLite databases across independent Effect scopes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InboundItem } from "../../contract.js";
import { DeliveryToken, openEndpointStore } from "../../endpoint/store.js";
import {
  persistInboxItem,
  readRuntimeInbox,
  recoverRuntimeInbox,
} from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Durable tombstone and snapshot fixtures pin exact store outcomes. */

const directories: string[] = [];
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "moltzap-runtime-inbox-"));
  directories.push(path);
  return path;
};
const digest = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;
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

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const preservesTokenBindings = () => {
  const path = directory();
  return Effect.runPromise(
    Effect.gen(function* () {
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
    }),
  );
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
  const path = directory();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storeRequestAndFailure(path);
      let recoveredToken: DeliveryToken | undefined;
      yield* Effect.scoped(
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
            id: request.kind === "collectiveRequest" ? request.id : undefined,
            to: "group:alice,bob,carol",
          });
          recoveredToken = lost?.deliveryToken;
          yield* store.acknowledgeInboxItem(token(2));
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
    }),
  );
};

const freezesPagesAcrossArrivalsAndAcknowledgments = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openEndpointStore(directory());
        for (let index = 1; index <= 51; index += 1) {
          yield* persistInboxItem(store, {
            deliveryToken: token(index),
            item: failure,
          });
        }
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
    ),
  );

const retainsInvocationAndEventState = () => {
  const path = directory();
  const input = new TextEncoder().encode(
    '{"input":{"text":"hello","to":"agent:bob"}}',
  );
  const outcome = new TextEncoder().encode('{"kind":"success","result":{}}');
  const eventState = new TextEncoder().encode('{"subscription":"private"}');
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          expect(yield* store.beginSendAttempt("finished", input)).toBe(
            "inserted",
          );
          yield* store.finishSendAttempt("finished", outcome);
          yield* store.beginSendAttempt("interrupted", input);
          yield* store.writeEventState(eventState);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          expect(yield* store.beginSendAttempt("finished", input)).toBe(
            "existing",
          );
          expect(yield* store.readSendAttempt("finished")).toEqual({
            canonicalInput: input,
            canonicalOutcome: outcome,
          });
          expect(yield* store.readSendAttempt("interrupted")).toEqual({
            canonicalInput: input,
          });
          expect(yield* store.readEventState()).toEqual(eventState);
          const conflict = yield* store
            .beginSendAttempt("finished", outcome)
            .pipe(Effect.flip);
          expect(conflict.reason).toBe("conflict");
        }),
      );
    }),
  );
};

const migratesWithoutErasingIdentity = () => {
  const path = directory();
  const identity = {
    agentId: "agent:alice",
    canonicalAgentCard: new Uint8Array([1, 2, 3]),
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        openEndpointStore(path).pipe(
          Effect.flatMap((store) => store.bindIdentity(identity)),
        ),
      );
      yield* Effect.sync(() => {
        const database = new DatabaseSync(join(path, "moltzapd.sqlite3"));
        database.exec(
          "DROP TABLE runtime_inbox; DROP TABLE runtime_sends; DROP TABLE runtime_events; DROP TABLE runtime_legacy_deliveries; PRAGMA user_version = 2",
        );
        database.close();
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          expect(yield* store.readIdentity()).toEqual(identity);
          expect(yield* store.readInboxSummary()).toEqual({
            pendingCount: 0,
            newestSequence: 0,
          });
          yield* persistInboxItem(store, {
            deliveryToken: token(1),
            item: failure,
          });
        }),
      );
      yield* Effect.sync(() => {
        const database = new DatabaseSync(join(path, "moltzapd.sqlite3"), {
          readOnly: true,
        });
        expect(database.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: 3,
        });
        database.close();
      });
    }),
  );
};

const commitsReceiptAtomically = () => {
  const path = directory();
  const state = new TextEncoder().encode('{"registration":null}');
  return Effect.runPromise(
    Effect.gen(function* () {
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
          expect((yield* store.readInboxItem(token(1)))?.acknowledged).toBe(
            true,
          );
          expect((yield* store.readInboxSummary()).pendingCount).toBe(0);
        }),
      );
    }),
  );
};

describe("durable runtime inbox", () => {
  it(
    "rolls back a failed receipt commit and retains a successful retirement across reopen",
    commitsReceiptAtomically,
  );
  it(
    "retains acknowledgment tombstones and rejects token payload collisions",
    preservesTokenBindings,
  );
  it(
    "replaces a lost request with one stable, separately identified failure",
    retiresLostRequests,
  );
  it(
    "bounds a snapshot while new arrivals and acknowledgments change unread state",
    freezesPagesAcrossArrivalsAndAcknowledgments,
  );
  it(
    "retains completed and interrupted invocations and event state across restart",
    retainsInvocationAndEventState,
  );
  it(
    "upgrades schema 2 without replacing the configured identity",
    migratesWithoutErasingIdentity,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
