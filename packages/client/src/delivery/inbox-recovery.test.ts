/** @file Schema upgrade preserves protocol state without reopening answered requests. */

import { Effect, Encoding, Option, Schema, Scope } from "effect";
import { expect, it } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  downgradeToSchemaV2,
  stateDirectory,
} from "../__tests__/store-schema-fixtures.js";
import {
  type CertifiedRecord,
  decodeRuntimeValue,
  type EndpointRecovery,
  type EndpointStore,
  openEndpointStore,
} from "../store/index.js";
import {
  collectiveIdOf,
  makeCollectiveOperations,
} from "../transport/collectives/index.js";
import { InboundMessage } from "../transport/messaging/message.js";
import { PostId, RecordHash } from "../transport/wire/index.js";
import { AgentAddress } from "../transport/wire/values.js";
import { readRuntimeInbox, recoverRuntimeInbox } from "./inbox.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const nonce = Encoding.encodeBase64Url(new Uint8Array(32).fill(8));
const id = collectiveIdOf(sender, nonce);
const recordHash = Schema.decodeUnknownSync(RecordHash)(digest("rch_", 3));
const foundation = {
  conversationId: "conversation:legacy-request",
  membershipHash: "mbr_legacy",
  canonicalMembership: bytes("members"),
  anchorHash: "anc_legacy",
  canonicalAnchor: bytes("anchor"),
};
const record: CertifiedRecord = {
  ...foundation,
  recordHash,
  actionHash: "ach_legacy",
  authorAgentId: "agent:bob",
  postId: digest("pst_", 1),
  canonicalRecordCore: bytes("record"),
  actionEvidence: [
    {
      conversationId: foundation.conversationId,
      kind: "action",
      subjectId: "ach_legacy",
      evidenceKey: "agent:bob",
      canonicalEvidence: bytes("action"),
    },
  ],
  durabilityEvidence: [
    {
      conversationId: foundation.conversationId,
      kind: "durability",
      subjectId: recordHash,
      evidenceKey: "agent:bob",
      canonicalEvidence: bytes("durability"),
    },
  ],
};
const message = () =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: record.postId,
    address: sender,
    sender,
    content: [
      { type: "text", text: "Please answer" },
      {
        type: "data",
        value: {
          "xyz.moltzap/collective": {
            kind: "operation",
            op: "gather",
            id,
            nonce,
            deadlineAt: Date.now() + 60_000,
            requestedSchema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      },
    ],
  });

const response = {
  to: sender,
  collectiveResponse: { action: "accept", content: { answer: "yes" } },
} as const;
const makeCollectives = (counter: { count: number }, scope: Scope.Scope) =>
  makeCollectiveOperations({
    self,
    lookupMember: () => Effect.void,
    sendPost: () =>
      Effect.sync(() => {
        counter.count += 1;
        return {
          postId: Schema.decodeUnknownSync(PostId)(
            digest("pst_", counter.count + 10),
          ),
          recordHash,
        };
      }),
    emit: () => Effect.void,
    scope,
  });
/**
 * Give the store alice's identity, a lock, an outbox entry and Bob's gather
 * request as a certified record whose delivery is still pending.
 */
const seedRequest = (store: EndpointStore, request: InboundMessage) =>
  Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: "agent:alice",
      canonicalAgentCard: bytes("identity"),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.lockProposal({
      conversationId: foundation.conversationId,
      actionHash: record.actionHash,
      canonicalActionCore: bytes("action-core"),
    });
    yield* store.applyCatchUpRecord(record, {
      recipientAgentId: "agent:alice",
      canonicalMessage: bytes(JSON.stringify(request)),
    });
    yield* store.enqueueOutbound({
      conversationId: foundation.conversationId,
      messageId: "msg_legacy",
      canonicalSignedMessage: bytes("outbound"),
    });
  });

/** Store Bob's request, still unanswered, and return what the store recovers. */
const storeRequest = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      yield* seedRequest(store, message());
      return yield* store.recover();
    }),
  );

/** Store Bob's request, answer it through a collective layer, and return what the store recovers. */
const storeAnsweredRequest = (path: string, counter: { count: number }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      const request = message();
      yield* seedRequest(store, request);
      const original = makeCollectives(counter, yield* Scope.Scope);
      yield* original.classify({ message: request, recordHash });
      yield* original.send(response, "result");
      return yield* store.recover();
    }),
  );
const checkRecoveredRequest = (
  path: string,
  counter: { count: number },
  before: EndpointRecovery,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      expect(yield* store.recover()).toEqual(before);
      yield* recoverRuntimeInbox(store);
      expect(yield* store.readPendingDeliveries()).toEqual([]);
      const inbox = yield* readRuntimeInbox(store, {});
      expect(inbox.items.map((entry) => entry.item)).toMatchObject([
        { kind: "operationFailed", id, to: sender },
      ]);
      expect(inbox.items[0]?.deliveryToken).not.toBe(
        before.pendingDeliveries[0]?.deliveryToken,
      );
      const restarted = makeCollectives(counter, yield* Scope.Scope);
      const rejected = yield* restarted
        .send(response, "result")
        .pipe(Effect.flip);
      expect(rejected).toMatchObject({
        _tag: "CollectiveError",
        failure: { kind: "request-none" },
      });
      expect(counter.count).toBe(1);
      yield* recoverRuntimeInbox(store);
      expect(yield* readRuntimeInbox(store, {})).toEqual(inbox);
    }),
  );
const preservesProtocolStateAndRetiresLegacyRequest = () => {
  const path = stateDirectory();
  const counter = { count: 0 };
  return Effect.runPromise(
    Effect.gen(function* () {
      const before = yield* storeAnsweredRequest(path, counter);
      yield* downgradeToSchemaV2(path);
      yield* Effect.scoped(openEndpointStore(path));
      yield* checkRecoveredRequest(path, counter, before);
    }),
  );
};

// @agent-code-guard/regression-only: the real schema 2 replay previously reopened an already answered request; sendPost is the only protocol side effect replaced by this fixture.
it(
  "preserves locks, records and outbox on upgrade while retiring an answered legacy request",
  preservesProtocolStateAndRetiresLegacyRequest,
);

const preservesUnprojectedRequest = () => {
  const path = stateDirectory();
  const counter = { count: 0 };
  return Effect.runPromise(
    Effect.gen(function* () {
      const before = yield* storeRequest(path);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          yield* recoverRuntimeInbox(store);
          const pending = yield* store.readPendingDeliveries();
          expect(pending).toEqual(before.pendingDeliveries);
          expect((yield* readRuntimeInbox(store, {})).items).toEqual([]);
          const entry = yield* Effect.fromNullable(pending[0]).pipe(
            Effect.orElse(() =>
              Effect.dieMessage(
                "expected the unprojected request to remain pending",
              ),
            ),
          );
          const restarted = makeCollectives(counter, yield* Scope.Scope);
          const item = yield* restarted.classify({
            message: yield* decodeRuntimeValue(
              InboundMessage,
              entry.canonicalMessage,
            ),
            recordHash,
          });
          expect(Option.getOrNull(item)).toMatchObject({
            kind: "collectiveRequest",
            id,
          });
          yield* restarted.send(response, "result");
          expect(counter.count).toBe(1);
        }),
      );
    }),
  );
};

it(
  "keeps an unprojected request answerable after restart of a current store",
  preservesUnprojectedRequest,
);
