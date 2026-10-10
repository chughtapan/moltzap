/** @file Pins the runtime state the endpoint store keeps across restart, and the empty store a pre-cutover schema version opens as. */

import { live as it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  databasePath,
  rewindToPreCutoverSchema,
  stateDirectory,
  storedConversation,
  withStore,
} from "../__tests__/store-schema-fixtures.js";
import {
  DeliveryToken,
  type EndpointStore,
  inspectEndpointStore,
} from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Store mutation outcomes and the schema version are the contract under test. */

const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 1));

function retainsInvocationAndEventState() {
  const path = stateDirectory();
  const input = bytes('{"input":{"text":"hello","to":"agent:bob"}}');
  const outcome = bytes('{"kind":"success","result":{}}');
  const eventState = bytes('{"subscription":"private"}');
  return Effect.gen(function* () {
    yield* withStore(path, (store) =>
      Effect.gen(function* () {
        expect(yield* store.beginSendAttempt("finished", input)).toBe(
          "inserted",
        );
        yield* store.finishSendAttempt("finished", outcome);
        yield* store.beginSendAttempt("interrupted", input);
        yield* store.writeEventState(eventState);
      }),
    );
    yield* withStore(path, (store) =>
      Effect.gen(function* () {
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
  });
}

const identity = {
  agentId: "agent:alice",
  canonicalAgentCard: new Uint8Array([1, 2, 3]),
};
const { foundation, record } = storedConversation("pre-cutover");
const sendInput = bytes('{"input":{"text":"hello","to":"agent:bob"}}');
const eventState = bytes('{"subscription":"private"}');
const inboxItem = bytes('{"kind":"operationFailed"}');

/**
 * Give the store Alice's identity, one certified conversation with a pending
 * delivery, a proposal lock, a post intent and a queued envelope, plus the
 * host's inbox, invocation and event state, and return the queued envelope's
 * outbox identity.
 */
const seedPreCutoverState = (store: EndpointStore) =>
  Effect.gen(function* () {
    yield* store.bindIdentity(identity);
    yield* store.putConversationFoundation(foundation);
    yield* store.bindPostIntent({
      kind: "existing-conversation",
      intent: {
        conversationId: foundation.conversationId,
        membershipHash: foundation.membershipHash,
        authorAgentId: identity.agentId,
        postId: digest("pst_", 2),
        canonicalIntent: bytes("intent"),
      },
    });
    yield* store.lockProposal({
      conversationId: foundation.conversationId,
      actionHash: record.actionHash,
      canonicalActionCore: bytes("action-core"),
    });
    yield* store.applyCertifiedRecord(record, {
      recipientAgentId: identity.agentId,
      canonicalMessage: bytes("delivery"),
    });
    const outbound = yield* store.enqueueOutbound({
      conversationId: foundation.conversationId,
      messageId: "msg_pre_cutover",
      canonicalSignedMessage: bytes("plaintext outer envelope"),
    });
    yield* store.beginSendAttempt("before-cutover", sendInput);
    yield* store.writeEventState(eventState);
    yield* store.putInboxItem({
      deliveryToken: token,
      canonicalItem: inboxItem,
    });
    return outbound.outboundId;
  });

/** What a newly created, unregistered store recovers. */
const freshRecovery = Effect.suspend(() =>
  withStore(stateDirectory(), (fresh) => fresh.recover()),
);

function readSchemaVersion(path: string) {
  const database = new DatabaseSync(databasePath(path), { readOnly: true });
  const row = database.prepare("PRAGMA user_version").get();
  database.close();
  return row;
}

const opensEmptyAfterTheCutover = (version: 2 | 3 | 4) => {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const outboundId = yield* withStore(path, seedPreCutoverState);
    yield* rewindToPreCutoverSchema(path, version);

    yield* withStore(path, (store) =>
      Effect.gen(function* () {
        expect(yield* store.readIdentity()).toBeUndefined();
        expect(yield* store.recover()).toEqual(yield* freshRecovery);
        const unsent = yield* store.beginOutbound(outboundId).pipe(Effect.flip);
        expect(unsent.reason).toBe("not-found");
        expect(yield* store.readSendAttempt("before-cutover")).toBeUndefined();
        expect(yield* store.readEventState()).toBeUndefined();
        expect(yield* store.readInboxSummary()).toEqual({
          pendingCount: 0,
          newestSequence: 0,
        });
      }),
    );
    expect(readSchemaVersion(path)).toMatchObject({ user_version: 5 });
  });
};

function inspectsWithoutWriting() {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const absent = yield* inspectEndpointStore(path);
    yield* withStore(path, seedPreCutoverState);
    const current = yield* inspectEndpointStore(path);
    yield* rewindToPreCutoverSchema(path, 3);
    const preCutover = yield* inspectEndpointStore(path);

    expect([absent, current, preCutover]).toEqual([
      "create",
      "reopen",
      "create",
    ]);
    expect(readSchemaVersion(path)).toMatchObject({ user_version: 3 });
  });
}

describe("endpoint runtime state", () => {
  it(
    "retains completed and interrupted invocations and event state across restart",
    retainsInvocationAndEventState,
  );
  it(
    "inspects how a store opens without creating or cutting it over",
    inspectsWithoutWriting,
  );
  it.each([4, 3, 2] as const)(
    "opens a schema version %i store empty, unregistered and without its queued envelope",
    opensEmptyAfterTheCutover,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
