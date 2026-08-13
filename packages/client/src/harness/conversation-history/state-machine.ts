/**
 * @file Owns the atomic staged-to-certified transition for one endpoint-local
 * conversation-history position.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import type { InvalidMembershipSizeError } from "./durability-quorum.js";
import {
  type CompleteEvidence,
  type ConflictingSignerEvidenceError,
  type EvidenceProgress,
  type EvidenceRequirement,
  EvidenceSubjectMismatchError,
  makeEvidenceProgress,
  mergeVerifiedEvidence,
  type NonMemberEvidenceSignerError,
} from "./evidence.js";

/** The compact head projection used by catch-up verification. */
export type CertifiedHistoryHead<Key> =
  | Readonly<{ readonly _tag: "empty" }>
  | Readonly<{ readonly _tag: "certified"; readonly recordHash: Key }>;

/** One verified value eligible to become the next certified position. */
export interface HistoryCandidate<Key, Value> {
  readonly key: Key;
  readonly value: Value;
}

/** A candidate and its verified evidence before local certification. */
export interface PendingHistoryPosition<Key, Value, Evidence> {
  readonly candidate: HistoryCandidate<Key, Value>;
  readonly evidence: EvidenceProgress<Key, Evidence>;
}

/** The endpoint's current certified value and complete evidence. */
export interface CertifiedHistoryPosition<Key, Value, Evidence> {
  readonly candidate: HistoryCandidate<Key, Value>;
  readonly evidence: CompleteEvidence<Key, Evidence>;
}

/** One durable state value; a transition commits this atomically. */
export interface ConversationHistoryState<Key, Value, Evidence> {
  readonly current: CertifiedHistoryPosition<Key, Value, Evidence> | null;
  readonly pending: PendingHistoryPosition<Key, Value, Evidence> | null;
}

/** A candidate does not extend the state's current certified position. */
export class HistoryPredecessorMismatchError<Key> extends Data.TaggedError(
  "HistoryPredecessorMismatchError",
)<{
  readonly currentKey: Key | null;
  readonly receivedKey: Key;
}> {}

/** Another candidate already occupies the single pending position. */
export class ConflictingPendingHistoryCandidateError<
  Key,
> extends Data.TaggedError("ConflictingPendingHistoryCandidateError")<{
  readonly pendingKey: Key;
  readonly receivedKey: Key;
}> {}

/** Evidence names no current or pending candidate. */
export class HistoryEvidenceWithoutCandidateError extends Data.TaggedError(
  "HistoryEvidenceWithoutCandidateError",
)<{
  readonly receivedKey: unknown;
}> {}

/** Result of staging a candidate in the durable state value. */
export interface HistoryStage<Key, Value, Evidence> {
  readonly state: ConversationHistoryState<Key, Value, Evidence>;
  readonly disposition: "staged" | "duplicate";
}

/** Result of incorporating verified evidence into the durable state value. */
export interface HistoryEvidenceMerge<Key, Value, Evidence> {
  readonly state: ConversationHistoryState<Key, Value, Evidence>;
  readonly disposition: "duplicate" | "collecting" | "certified" | "enriched";
  readonly certified: CertifiedHistoryPosition<Key, Value, Evidence> | null;
}

interface HistoryStageInput<Key, Value, Evidence> {
  readonly state: ConversationHistoryState<Key, Value, Evidence>;
  readonly candidate: HistoryCandidate<Key, Value>;
  readonly memberAgentIds: ReadonlySet<AgentId>;
  readonly requirement: EvidenceRequirement;
  readonly sameKey: (left: Key, right: Key) => boolean;
  readonly extendsCurrent: (
    current: CertifiedHistoryPosition<Key, Value, Evidence> | null,
    candidate: HistoryCandidate<Key, Value>,
  ) => boolean;
}

interface HistoryEvidenceInput<Key, Value, Evidence> {
  readonly state: ConversationHistoryState<Key, Value, Evidence>;
  readonly received: {
    readonly subject: Key;
    readonly signerAgentId: AgentId;
    readonly evidence: Evidence;
  };
  readonly sameKey: (left: Key, right: Key) => boolean;
  readonly sameEvidence: (left: Evidence, right: Evidence) => boolean;
}

type HistoryEvidenceError<Key, Evidence> =
  | ConflictingSignerEvidenceError<Evidence>
  | EvidenceSubjectMismatchError<Key>
  | HistoryEvidenceWithoutCandidateError
  | NonMemberEvidenceSignerError;

/**
 * Creates the only empty history state.
 *
 * @returns An immutable state without a current or pending position.
 */
export const emptyConversationHistory = <
  Key,
  Value,
  Evidence,
>(): ConversationHistoryState<Key, Value, Evidence> =>
  Object.freeze({ current: null, pending: null });

/**
 * Stages one verified child without creating a second restart-only state.
 *
 * The caller atomically stores the returned value before producing its own
 * evidence. Loading that value after restart is sufficient to resume.
 *
 * @param input Current durable state, candidate, membership, and trusted checks.
 * @returns The next state or one fail-closed conflict.
 */
export const stageHistoryCandidate = <Key, Value, Evidence>(
  input: HistoryStageInput<Key, Value, Evidence>,
): Either.Either<
  HistoryStage<Key, Value, Evidence>,
  | ConflictingPendingHistoryCandidateError<Key>
  | HistoryPredecessorMismatchError<Key>
  | InvalidMembershipSizeError
> => {
  const duplicate = duplicateStage(input);
  if (duplicate !== null) {
    return Either.right(duplicate);
  }
  if (!input.extendsCurrent(input.state.current, input.candidate)) {
    return Either.left(
      new HistoryPredecessorMismatchError({
        currentKey: input.state.current?.candidate.key ?? null,
        receivedKey: input.candidate.key,
      }),
    );
  }
  if (input.state.pending !== null) {
    return Either.left(
      new ConflictingPendingHistoryCandidateError({
        pendingKey: input.state.pending.candidate.key,
        receivedKey: input.candidate.key,
      }),
    );
  }

  return Either.map(
    makeEvidenceProgress<Key, Evidence>({
      subject: input.candidate.key,
      memberAgentIds: input.memberAgentIds,
      requirement: input.requirement,
    }),
    (evidence) =>
      Object.freeze({
        state: Object.freeze({
          current: input.state.current,
          pending: Object.freeze({
            candidate: snapshotCandidate(input.candidate),
            evidence,
          }),
        }),
        disposition: "staged" as const,
      }),
  );
};

function duplicateStage<Key, Value, Evidence>(
  input: HistoryStageInput<Key, Value, Evidence>,
): HistoryStage<Key, Value, Evidence> | null {
  const currentMatches =
    input.state.current !== null &&
    input.sameKey(input.state.current.candidate.key, input.candidate.key);
  const pendingMatches =
    input.state.pending !== null &&
    input.sameKey(input.state.pending.candidate.key, input.candidate.key);
  return currentMatches || pendingMatches
    ? Object.freeze({ state: input.state, disposition: "duplicate" as const })
    : null;
}

/**
 * Merges evidence and promotes a completed candidate in the same transition.
 *
 * A persisted pending state is always resumable. If loaded evidence already
 * satisfies the requirement, even a duplicate merge performs the promotion;
 * no separate restart planner or promotion slot is necessary.
 *
 * @param input Current durable state and one already-verified evidence item.
 * @returns The next atomic state and whether a certification occurred.
 */
export const mergeHistoryEvidence = <Key, Value, Evidence>(
  input: HistoryEvidenceInput<Key, Value, Evidence>,
): Either.Either<
  HistoryEvidenceMerge<Key, Value, Evidence>,
  HistoryEvidenceError<Key, Evidence>
> => {
  if (
    input.state.pending !== null &&
    input.sameKey(input.state.pending.candidate.key, input.received.subject)
  ) {
    return mergePendingEvidence(input, input.state.pending);
  }
  if (
    input.state.current !== null &&
    input.sameKey(input.state.current.candidate.key, input.received.subject)
  ) {
    return mergeCurrentEvidence(input, input.state.current);
  }
  if (input.state.pending !== null) {
    return Either.left(
      new EvidenceSubjectMismatchError({
        expectedSubject: input.state.pending.candidate.key,
        receivedSubject: input.received.subject,
      }),
    );
  }
  if (input.state.current !== null) {
    return Either.left(
      new EvidenceSubjectMismatchError({
        expectedSubject: input.state.current.candidate.key,
        receivedSubject: input.received.subject,
      }),
    );
  }
  return Either.left(
    new HistoryEvidenceWithoutCandidateError({
      receivedKey: input.received.subject,
    }),
  );
};

/**
 * Projects a history state into the compact catch-up head.
 *
 * @param state Durable endpoint-local conversation-history state.
 * @returns Empty or the current certified record identity.
 */
export const certifiedHistoryHead = <Key, Value, Evidence>(
  state: ConversationHistoryState<Key, Value, Evidence>,
): CertifiedHistoryHead<Key> =>
  state.current === null
    ? Object.freeze({ _tag: "empty" as const })
    : Object.freeze({
        _tag: "certified" as const,
        recordHash: state.current.candidate.key,
      });

function mergePendingEvidence<Key, Value, Evidence>(
  input: HistoryEvidenceInput<Key, Value, Evidence>,
  pending: PendingHistoryPosition<Key, Value, Evidence>,
): Either.Either<
  HistoryEvidenceMerge<Key, Value, Evidence>,
  HistoryEvidenceError<Key, Evidence>
> {
  return Either.map(mergeEvidence(input, pending.evidence), (merged) => {
    if (merged.completion !== null) {
      const current = Object.freeze({
        candidate: pending.candidate,
        evidence: merged.completion,
      });
      return Object.freeze({
        state: Object.freeze({ current, pending: null }),
        disposition: "certified" as const,
        certified: current,
      });
    }
    return Object.freeze({
      state: Object.freeze({
        current: input.state.current,
        pending: Object.freeze({
          candidate: pending.candidate,
          evidence: merged.progress,
        }),
      }),
      disposition:
        merged.disposition === "duplicate"
          ? ("duplicate" as const)
          : ("collecting" as const),
      certified: null,
    });
  });
}

function mergeCurrentEvidence<Key, Value, Evidence>(
  input: HistoryEvidenceInput<Key, Value, Evidence>,
  current: CertifiedHistoryPosition<Key, Value, Evidence>,
): Either.Either<
  HistoryEvidenceMerge<Key, Value, Evidence>,
  HistoryEvidenceError<Key, Evidence>
> {
  return Either.map(mergeEvidence(input, current.evidence), (merged) => {
    const nextCurrent = Object.freeze({
      candidate: current.candidate,
      evidence: merged.completion ?? current.evidence,
    });
    return Object.freeze({
      state: Object.freeze({
        current: nextCurrent,
        pending: input.state.pending,
      }),
      disposition:
        merged.disposition === "enriched"
          ? ("enriched" as const)
          : ("duplicate" as const),
      certified: nextCurrent,
    });
  });
}

function mergeEvidence<Key, Value, Evidence>(
  input: HistoryEvidenceInput<Key, Value, Evidence>,
  progress: EvidenceProgress<Key, Evidence>,
) {
  return mergeVerifiedEvidence({
    progress,
    received: input.received,
    sameSubject: input.sameKey,
    sameEvidence: input.sameEvidence,
  });
}

function snapshotCandidate<Key, Value>(
  candidate: HistoryCandidate<Key, Value>,
): HistoryCandidate<Key, Value> {
  return Object.freeze({ ...candidate });
}
