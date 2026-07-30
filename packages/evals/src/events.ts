/** @file Evaluation events and typed simulator runtime evidence projections. */

import { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { AgentId } from "@moltzap/protocol/identity";
import { TaskId } from "@moltzap/protocol/task";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentRuntimeStartFailed,
  EventCatalog,
  IncompleteLedgerReceipt,
  type LedgerReceipt,
} from "@moltzap/simulator";
import type { LedgerRef } from "@moltzap/simulator/ledger";
import { Chunk, Effect, Option, Schema, Stream } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { EvaluationCaseId } from "./cases.js";
import {
  EpisodeParticipantRole,
  type EpisodeParticipant,
  type EpisodeResponse,
  type EpisodeResult,
} from "./episodes.js";

/** A case assigns endpoint meaning that the content-blind network does not. */
export class EvaluationParticipantAssigned extends Schema.TaggedClass<EvaluationParticipantAssigned>()(
  "moltzap.evaluation-participant-assigned/v1",
  {
    caseId: EvaluationCaseId,
    participantName: Schema.NonEmptyString,
    participantId: AgentId,
    role: EpisodeParticipantRole,
  },
) {}

/** A case selects one canonical target delivery as rubric evidence. */
export class EvaluationResponseSelected extends Schema.TaggedClass<EvaluationResponseSelected>()(
  "moltzap.evaluation-response-selected/v4",
  {
    caseId: EvaluationCaseId,
    endpointName: Schema.NonEmptyString,
    endpointId: AgentId,
    targetName: Schema.NonEmptyString,
    targetId: AgentId,
    taskId: TaskId,
    conversationId: ConversationId,
    promptMessageId: MessageId,
    messageId: MessageId,
  },
) {}

/** The closed customer event universe shared by every evaluation case. */
export const EvaluationEvents = EventCatalog.make(
  EvaluationParticipantAssigned,
  EvaluationResponseSelected,
);

/**
 * Runtime startup failure and autonomous termination events that evaluation
 * policy can act on without interpreting process-specific strings.
 */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- evaluation outcomes persist this closed simulator-owned event projection.
export const RuntimeTerminationEvidence = Schema.Union(
  AgentRuntimeStartFailed,
  AgentRuntimeCompleted,
  AgentRuntimeFailed,
  AgentProcessExited,
  AgentProcessSignaled,
);
export type RuntimeTerminationEvidence = typeof RuntimeTerminationEvidence.Type;

/** Ordered ledger envelope fields required by runtime evidence projection. */
interface RuntimeEvidenceLedgerRecord {
  readonly event: unknown;
}

/** Live and completed ledgers share this ordered record capability. */
export interface RuntimeEvidenceLedger<Failure = never> {
  readonly records: Stream.Stream<RuntimeEvidenceLedgerRecord, Failure>;
}

/** A completed ledger was read and its complete runtime evidence is known. */
export class RuntimeTerminationEvidenceRead extends Schema.TaggedClass<RuntimeTerminationEvidenceRead>()(
  "RuntimeTerminationEvidenceRead",
  {
    observations: Schema.Array(RuntimeTerminationEvidence),
  },
) {}

/** An incomplete ledger cannot establish complete runtime evidence. */
export class RuntimeTerminationEvidenceIncompleteLedger extends Schema.TaggedClass<RuntimeTerminationEvidenceIncompleteLedger>()(
  "RuntimeTerminationEvidenceIncompleteLedger",
  {},
) {}

/** A completed ledger existed but could not be validated and read. */
export class RuntimeTerminationEvidenceReadFailed extends Schema.TaggedClass<RuntimeTerminationEvidenceReadFailed>()(
  "RuntimeTerminationEvidenceReadFailed",
  {
    detail: Schema.NonEmptyString,
  },
) {}

// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- probe outcomes persist this closed evidence-read result.
export const RuntimeTerminationEvidenceReadOutcome = Schema.Union(
  RuntimeTerminationEvidenceRead,
  RuntimeTerminationEvidenceIncompleteLedger,
  RuntimeTerminationEvidenceReadFailed,
);
export type RuntimeTerminationEvidenceReadOutcome =
  typeof RuntimeTerminationEvidenceReadOutcome.Type;

/**
 * Project simulator-owned runtime lifecycle evidence in ledger order.
 *
 * The same projection accepts live and completed ledgers. Consumers choose
 * whether to wait for the first observation or collect a completed history.
 */
function runtimeTerminationEvidence<Failure>(
  ledger: RuntimeEvidenceLedger<Failure>,
): Stream.Stream<RuntimeTerminationEvidence, Failure> {
  return ledger.records.pipe(
    Stream.filterMap((record) =>
      Schema.decodeUnknownOption(RuntimeTerminationEvidence)(record.event),
    ),
  );
}

/** Collect the complete ordered runtime evidence from a completed ledger. */
export const runtimeTerminationEvidenceFromLedger = Effect.fn(
  "evals.runtimeTerminationEvidenceFromLedger",
)(function* <Failure>(ledger: RuntimeEvidenceLedger<Failure>) {
  const observations = yield* runtimeTerminationEvidence(ledger).pipe(
    Stream.runCollect,
  );
  return Chunk.toReadonlyArray(observations);
});

/**
 * Wait until a live ledger records a runtime startup failure or autonomous
 * termination. A cleanly completed stream without such evidence stays idle.
 */
export const waitForRuntimeTerminationEvidence = Effect.fn(
  "evals.waitForRuntimeTerminationEvidence",
)(function* <Failure>(ledger: RuntimeEvidenceLedger<Failure>) {
  const first = yield* runtimeTerminationEvidence(ledger).pipe(Stream.runHead);
  return yield* Option.match(first, {
    onNone: () => Effect.never,
    onSome: Effect.succeed,
  });
});

function evidenceReadFailureDetail(error: unknown): string {
  const detail = String(error).trim();
  return detail.length > 0 ? detail : "the completed ledger could not be read";
}

/**
 * Read runtime evidence when a receipt proves ledger completion, preserving
 * incomplete and unreadable ledgers as distinct typed outcomes.
 */
export const readRuntimeTerminationEvidence = Effect.fn(
  "evals.readRuntimeTerminationEvidence",
)(function* <OpenFailure, Requirements>(
  receipt: LedgerReceipt,
  openLedger: (
    ref: LedgerRef,
  ) => Effect.Effect<RuntimeEvidenceLedger, OpenFailure, Requirements>,
) {
  if (receipt instanceof IncompleteLedgerReceipt) {
    return RuntimeTerminationEvidenceIncompleteLedger.make();
  }
  return yield* openLedger(receipt.ledger).pipe(
    Effect.flatMap(runtimeTerminationEvidenceFromLedger),
    Effect.match({
      onFailure: (error) =>
        RuntimeTerminationEvidenceReadFailed.make({
          detail: evidenceReadFailureDetail(error),
        }),
      onSuccess: (observations) =>
        RuntimeTerminationEvidenceRead.make({ observations }),
    }),
  );
});

/** Record all episode roles once, in episode-declared topology order. */
export function participantAssignmentsForEpisode(
  caseId: EvaluationCaseId,
  result: EpisodeResult,
): NonEmptyReadonlyArray<EvaluationParticipantAssigned> {
  const [first, ...remaining] = result.participants;
  return [
    assignEvaluationParticipant(caseId, first),
    ...remaining.map((value) => assignEvaluationParticipant(caseId, value)),
  ];
}

/** Construct an assignment directly for focused episode tests. */
function assignEvaluationParticipant(
  caseId: EvaluationCaseId,
  participant: EpisodeParticipant,
): EvaluationParticipantAssigned {
  return EvaluationParticipantAssigned.make({
    caseId,
    participantName: participant.name,
    participantId: participant.id,
    role: participant.role,
  });
}

/** Refer to a selected delivery without copying its content into an event. */
export function selectEvaluationResponse(
  caseId: EvaluationCaseId,
  response: EpisodeResponse,
): EvaluationResponseSelected {
  return EvaluationResponseSelected.make({
    caseId,
    endpointName: response.endpointName,
    endpointId: response.endpointId,
    targetName: response.targetName,
    targetId: response.targetId,
    taskId: response.received.taskId,
    conversationId: response.received.message.conversationId,
    promptMessageId: response.promptMessageId,
    messageId: response.received.message.id,
  });
}
