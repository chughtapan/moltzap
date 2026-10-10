/** @file A pending collective request delivery stays answerable across a restart of a current store. */

import { live as it } from "@effect/vitest";
import { Effect, Encoding, Option, Schema, Scope } from "effect";
import { expect } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
} from "../__tests__/store-schema-fixtures.js";
import {
  decodeRuntimeValue,
  type EndpointStore,
  openEndpointStore,
} from "../store/index.js";
import { makeCollectiveOperations } from "../transport/collectives/index.js";
import { collectiveIdOf } from "../transport/collectives/part/index.js";
import { InboundMessage } from "../transport/messaging/message.js";
import { PostId, RecordHash } from "../transport/wire/index.js";
import { AgentAddress } from "../transport/wire/values.js";
import { readRuntimeInbox, recoverRuntimeInbox } from "./inbox.js";

const self = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const sender = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const nonce = Encoding.encodeBase64Url(new Uint8Array(32).fill(8));
const id = collectiveIdOf(sender, nonce);
const { foundation, record } = storedConversation("pending-request");
const recordHash = Schema.decodeUnknownSync(RecordHash)(record.recordHash);
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
 * Give the store alice's identity and Bob's gather request as a certified
 * record whose delivery is still pending.
 */
const seedRequest = (store: EndpointStore, request: InboundMessage) =>
  Effect.gen(function* () {
    yield* store.bindIdentity({
      agentId: "agent:alice",
      canonicalAgentCard: bytes("identity"),
    });
    yield* store.putConversationFoundation(foundation);
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: "agent:alice",
      canonicalMessage: bytes(JSON.stringify(request)),
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

const preservesUnprojectedRequest = () => {
  const path = stateDirectory();
  const counter = { count: 0 };
  return Effect.gen(function* () {
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
  });
};

it(
  "keeps an unprojected request answerable after restart of a current store",
  preservesUnprojectedRequest,
);
