/**
 * @file Pins atomic staging, certification, replay, and evidence enrichment
 * for the private conversation-history state machine.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type EvidenceProgress,
  makeEvidenceProgress,
  mergeVerifiedEvidence,
} from "./evidence.js";
import {
  type ConversationHistoryState,
  emptyConversationHistory,
  mergeHistoryEvidence,
  stageHistoryCandidate,
} from "./state-machine.js";

interface RecordValue {
  readonly previousRecordHash: string | null;
  readonly body: string;
}

type State = ConversationHistoryState<string, RecordValue, string>;

const member = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const MEMBERS = [member(1), member(2), member(3), member(4)] as const;
const MEMBER_SET = new Set<AgentIdValue>(MEMBERS);
const RECORD_ONE = "record:one";
const RECORD_TWO = "record:two";

const candidate = (
  key: string,
  previousRecordHash: string | null,
): { readonly key: string; readonly value: RecordValue } => ({
  key,
  value: { previousRecordHash, body: `body:${key}` },
});

const stage = (state: State, key: string, previous: string | null) =>
  stageHistoryCandidate({
    state,
    candidate: {
      key,
      value: { previousRecordHash: previous, body: `body:${key}` },
    },
    memberAgentIds: MEMBER_SET,
    requirement: "durability-quorum",
    sameKey: (left, right) => left === right,
    extendsCurrent: (current, received) =>
      received.value.previousRecordHash === (current?.candidate.key ?? null),
  });

const merge = (state: State, subject: string, signerAgentId: AgentIdValue) =>
  mergeHistoryEvidence({
    state,
    received: {
      subject,
      signerAgentId,
      evidence: `vote:${signerAgentId}`,
    },
    sameKey: (left, right) => left === right,
    sameEvidence: (left, right) => left === right,
  });

const failed = <Success, Failure>(result: Either.Either<Success, Failure>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected transition to fail");
    },
  });

// @agent-code-guard/regression-only: these examples pin idempotent staging, ancestry refusal, and the single-child invariant.
describe("conversation history staging", () => {
  it("keeps one idempotent candidate at the current predecessor", () => {
    const initial = emptyConversationHistory<string, RecordValue, string>();
    const staged = Either.getOrThrow(stage(initial, RECORD_ONE, null));
    const duplicate = Either.getOrThrow(stage(staged.state, RECORD_ONE, null));

    expect(staged).toMatchObject({ disposition: "staged" });
    expect(duplicate).toMatchObject({ disposition: "duplicate" });
    expect(duplicate.state).toBe(staged.state);
    expect(Object.isFrozen(staged.state)).toBe(true);
  });

  it("rejects stale ancestry and a conflicting pending child", () => {
    const initial = emptyConversationHistory<string, RecordValue, string>();
    const staged = Either.getOrThrow(stage(initial, RECORD_ONE, null));

    expect(
      failed(stage(initial, "record:stale", "record:missing")),
    ).toMatchObject({ _tag: "HistoryPredecessorMismatchError" });
    expect(failed(stage(staged.state, "record:other", null))).toMatchObject({
      _tag: "ConflictingPendingHistoryCandidateError",
      pendingKey: RECORD_ONE,
      receivedKey: "record:other",
    });
  });
});

// @agent-code-guard/regression-only: this example pins atomic threshold promotion.
describe("conversation history certification", () => {
  it("promotes and clears pending state in the threshold transition", () => {
    let state = Either.getOrThrow(
      stage(
        emptyConversationHistory<string, RecordValue, string>(),
        RECORD_ONE,
        null,
      ),
    ).state;

    for (const signerAgentId of MEMBERS.slice(0, 2)) {
      const collected = Either.getOrThrow(
        merge(state, RECORD_ONE, signerAgentId),
      );
      expect(collected).toMatchObject({ disposition: "collecting" });
      state = collected.state;
    }
    const certified = Either.getOrThrow(merge(state, RECORD_ONE, MEMBERS[2]));

    expect(certified).toMatchObject({ disposition: "certified" });
    expect(certified.state.pending).toBeNull();
    expect(certified.state.current?.candidate.key).toBe(RECORD_ONE);
    expect(certified.certified?.evidence.evidenceBySigner).toHaveLength(3);
  });
});

// @agent-code-guard/regression-only: these examples pin recovery by reload, completed retries, enrichment, and successor staging.
describe("conversation history replay", () => {
  it("handles completed retries and later evidence without another planner", () => {
    let state = certifiedState();
    const duplicate = Either.getOrThrow(merge(state, RECORD_ONE, MEMBERS[0]));
    state = duplicate.state;
    const enriched = Either.getOrThrow(merge(state, RECORD_ONE, MEMBERS[3]));

    expect(duplicate).toMatchObject({ disposition: "duplicate" });
    expect(enriched).toMatchObject({ disposition: "enriched" });
    expect(enriched.state.current?.evidence.evidenceBySigner).toHaveLength(4);
  });

  it("promotes a recovered quorum-complete pending value on replay", () => {
    const completeProgress = quorumProgress();
    const recovered: State = Object.freeze({
      current: null,
      pending: Object.freeze({
        candidate: candidate(RECORD_ONE, null),
        evidence: completeProgress,
      }),
    });
    const replayed = Either.getOrThrow(
      merge(recovered, RECORD_ONE, MEMBERS[0]),
    );

    expect(replayed).toMatchObject({ disposition: "certified" });
    expect(replayed.state.pending).toBeNull();
    expect(replayed.state.current?.candidate.key).toBe(RECORD_ONE);
  });

  it("accepts a successor only after its predecessor is current", () => {
    const state = certifiedState();
    const successor = Either.getOrThrow(stage(state, RECORD_TWO, RECORD_ONE));

    expect(successor.state.pending?.candidate).toEqual(
      candidate(RECORD_TWO, RECORD_ONE),
    );
  });
});

function quorumProgress(): EvidenceProgress<string, string> {
  let progress = Either.getOrThrow(
    makeEvidenceProgress<string, string>({
      subject: RECORD_ONE,
      memberAgentIds: MEMBER_SET,
      requirement: "durability-quorum",
    }),
  );
  for (const signerAgentId of MEMBERS.slice(0, 3)) {
    progress = Either.getOrThrow(
      mergeVerifiedEvidence({
        progress,
        received: {
          subject: RECORD_ONE,
          signerAgentId,
          evidence: `vote:${signerAgentId}`,
        },
        sameSubject: (left, right) => left === right,
        sameEvidence: (left, right) => left === right,
      }),
    ).progress;
  }
  return progress;
}

function certifiedState(): State {
  let state = Either.getOrThrow(
    stage(
      emptyConversationHistory<string, RecordValue, string>(),
      RECORD_ONE,
      null,
    ),
  ).state;
  for (const signerAgentId of MEMBERS.slice(0, 3)) {
    state = Either.getOrThrow(merge(state, RECORD_ONE, signerAgentId)).state;
  }
  return state;
}
