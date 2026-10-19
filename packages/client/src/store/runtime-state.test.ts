/** @file Runtime state and interrupted admission checks survive store restart. */

import { live as it } from "@effect/vitest";
import { Array, Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  stateDirectory,
  storedConversation,
  withStore,
} from "../__tests__/store-schema-fixtures.js";
import {
  type CertifiedRecord,
  DeliveryToken,
  type EndpointStore,
  inspectEndpointStore,
} from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Store mutation outcomes and recovery state are the contract under test. */

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
const { foundation, record } = storedConversation("restart");
const sendInput = bytes('{"input":{"text":"hello","to":"agent:bob"}}');
const eventState = bytes('{"subscription":"private"}');
const inboxItem = bytes('{"kind":"operationFailed"}');

/**
 * Give the store Alice's identity, one certified conversation with a pending
 * delivery, a proposal lock, a post intent and a queued envelope, plus the
 * host's inbox, invocation and event state, and return the queued envelope's
 * outbox identity.
 */
const seedState = (store: EndpointStore) =>
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
      messageId: "msg_restart",
      canonicalSignedMessage: bytes("plaintext outer envelope"),
    });
    yield* store.beginSendAttempt("before-restart", sendInput);
    yield* store.writeEventState(eventState);
    yield* store.putInboxItem({
      deliveryToken: token,
      canonicalItem: inboxItem,
    });
    return outbound.outboundId;
  });

function reportsHowCurrentStoreOpens() {
  const path = stateDirectory();
  return Effect.gen(function* () {
    const absent = yield* inspectEndpointStore(path);
    yield* withStore(path, seedState);
    const current = yield* inspectEndpointStore(path);

    expect([absent, current]).toEqual(["create", "reopen"]);
    expect(yield* withStore(path, (store) => store.readIdentity())).toEqual(
      identity,
    );
  });
}

function preservesStateAcrossRestart() {
  const path = stateDirectory();
  return Effect.gen(function* () {
    yield* withStore(path, seedState);
    const before = yield* withStore(path, (store) => store.recover());
    yield* withStore(path, (store) =>
      Effect.gen(function* () {
        expect(yield* store.readIdentity()).toEqual(identity);
        expect(yield* store.recover()).toEqual(before);
        expect(yield* store.readSendAttempt("before-restart")).toEqual({
          canonicalInput: sendInput,
        });
        expect(yield* store.readEventState()).toEqual(eventState);
        expect((yield* store.readInbox()).items[0]?.canonicalItem).toEqual(
          inboxItem,
        );
        expect(
          (yield* store.readFirewallEvidence({ maximumRecords: 10 }))
            .pendingOutgoing,
        ).toBe(true);
      }),
    );
  });
}

function invalidatesInterruptedChecks() {
  const path = stateDirectory();
  const checkId = "interrupted-check";
  const completion = { checkId, admit: true, canonicalResult: bytes("allow") };
  return Effect.gen(function* () {
    yield* withStore(path, (store) =>
      Effect.gen(function* () {
        yield* seedState(store);
        const evidence = yield* store.readFirewallEvidence({
          maximumRecords: 10,
        });
        yield* store.beginFirewallAttempt({
          checkId,
          direction: "outgoing",
          revision: evidence.revision,
          canonicalCandidate: bytes("draft"),
          canonicalInput: bytes("fixed policy and evidence"),
        });
      }),
    );
    yield* withStore(path, (store) =>
      Effect.gen(function* () {
        expect(
          (yield* store.readFirewallEvidence({ maximumRecords: 10 }))
            .pendingOutgoing,
        ).toBe(true);
        expect(
          yield* Effect.flip(store.finishFirewallAttempt(completion)),
        ).toMatchObject({ reason: "conflict" });
        expect((yield* store.recover()).postIntents).toHaveLength(1);
      }),
    );
  });
}

function historyRecord(ordinal: number): CertifiedRecord {
  const { record } = storedConversation("history-window");
  const recordHash = `rch_history:${ordinal}`;
  const actionHash = `ach_history:${ordinal}`;
  return {
    ...record,
    recordHash,
    actionHash,
    postId: `pst_history:${ordinal}`,
    canonicalRecordCore: bytes(`history:${ordinal}`),
    ...(ordinal === 0
      ? {}
      : { previousRecordHash: `rch_history:${ordinal - 1}` }),
    actionEvidence: record.actionEvidence.map((evidence) => ({
      ...evidence,
      subjectId: actionHash,
    })),
    durabilityEvidence: record.durabilityEvidence.map((evidence) => ({
      ...evidence,
      subjectId: recordHash,
    })),
  };
}

function selectsRecentHistoryFromALongConversation() {
  const path = stateDirectory();
  const { foundation } = storedConversation("history-window");
  const other = storedConversation("other-history");
  const delivery = {
    recipientAgentId: identity.agentId,
    canonicalMessage: bytes("delivery"),
  };
  return withStore(path, (store) =>
    Effect.gen(function* () {
      yield* store.bindIdentity(identity);
      yield* store.putConversationFoundation(other.foundation);
      yield* store.applyCertifiedRecord(other.record, delivery);
      yield* store.putConversationFoundation(foundation);
      yield* Effect.forEach(
        Array.range(0, 1_003),
        (ordinal) =>
          store.applyCertifiedRecord(historyRecord(ordinal), delivery),
        { concurrency: 1, discard: true },
      );
      const candidate = (yield* store.readPendingDeliveries()).find(
        (item) => item.recordHash === "rch_history:1002",
      );
      if (candidate === undefined) {
        return yield* Effect.dieMessage("missing candidate delivery");
      }

      const incoming = yield* store.readFirewallEvidence({
        beforeDelivery: candidate.deliveryToken,
        maximumRecords: 2,
      });
      const outgoing = yield* store.readFirewallEvidence({
        conversationId: foundation.conversationId,
        maximumRecords: 2,
      });

      expect(
        incoming.history.map((entry) => entry.canonicalRecordCore),
      ).toEqual([bytes("history:1000"), bytes("history:1001")]);
      expect(incoming.candidate?.canonicalRecordCore).toEqual(
        bytes("history:1002"),
      );
      expect(
        outgoing.history.map((entry) => entry.canonicalRecordCore),
      ).toEqual([bytes("history:1002"), bytes("history:1003")]);
      expect(incoming.earlierHistoryOmitted).toBe(true);
      expect(outgoing.earlierHistoryOmitted).toBe(true);
      expect(incoming.overflow).toBe(false);
      expect(outgoing.overflow).toBe(false);
    }),
  );
}

describe("endpoint runtime state", () => {
  it(
    "preserves identity, protocol and admitted runtime state across restart",
    preservesStateAcrossRestart,
  );
  it(
    "invalidates interrupted checks while preserving unresolved intent evidence",
    invalidatesInterruptedChecks,
  );
  it(
    "retains completed and interrupted invocations and event state across restart",
    retainsInvocationAndEventState,
  );
  it(
    "reports creation and reopening without changing stored identity",
    reportsHowCurrentStoreOpens,
  );
  it(
    "selects recent incoming and outgoing windows from a long conversation",
    selectsRecentHistoryFromALongConversation,
    { timeout: 30_000 },
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
