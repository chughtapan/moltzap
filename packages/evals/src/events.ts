/** @file Evaluation events and typed simulator evidence projections. */

import { AgentName as agentName } from "@moltzap/client";
import { EventCatalog } from "@moltzap/simulator";
import {
  NanoClawGatewayInput,
  NanoClawGatewayOutput,
  OpenClawGatewayRequest,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
} from "@moltzap/simulator/agents";
import { Chunk, Effect, Schema, Stream } from "effect";
import {
  evaluationCaseId,
  evaluationEvidenceId,
  type EvaluationEvidenceId,
} from "./model.js";

const openClawGatewayResponse = Schema.Union(
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
);

/** The adapter recorded an instruction before submitting it to OpenClaw. */
export class OpenClawPrincipalInstructionAttempted extends Schema.TaggedClass<OpenClawPrincipalInstructionAttempted>()(
  "moltzap.openclaw-principal-instruction-attempted/v1",
  {
    caseId: evaluationCaseId,
    agentName,
    request: OpenClawGatewayRequest,
  },
) {}

/** OpenClaw's native principal gateway returned its terminal output. */
export class OpenClawPrincipalFinalOutput extends Schema.TaggedClass<OpenClawPrincipalFinalOutput>()(
  "moltzap.openclaw-principal-final-output/v1",
  {
    caseId: evaluationCaseId,
    agentName,
    idempotencyKey: Schema.NonEmptyString,
    output: openClawGatewayResponse,
  },
) {}

/** The adapter sent one input frame to NanoClaw's principal socket. */
export class NanoClawPrincipalInputSent extends Schema.TaggedClass<NanoClawPrincipalInputSent>()(
  "moltzap.nanoclaw-principal-input-sent/v1",
  {
    caseId: evaluationCaseId,
    agentName,
    input: NanoClawGatewayInput,
  },
) {}

/** The adapter received one output frame from NanoClaw. */
export class NanoClawPrincipalOutputReceived extends Schema.TaggedClass<NanoClawPrincipalOutputReceived>()(
  "moltzap.nanoclaw-principal-output-received/v1",
  {
    caseId: evaluationCaseId,
    agentName,
    output: NanoClawGatewayOutput,
  },
) {}

/** A case selected one earlier observation for grading. */
export class EvaluationEvidenceSelected extends Schema.TaggedClass<EvaluationEvidenceSelected>()(
  "moltzap.evaluation-evidence-selected/v1",
  {
    caseId: evaluationCaseId,
    selectedEventId: evaluationEvidenceId,
  },
) {}

/** The complete customer event universe shared by bundled evaluations. */
export const evaluationEvents = EventCatalog.make(
  OpenClawPrincipalInstructionAttempted,
  OpenClawPrincipalFinalOutput,
  NanoClawPrincipalInputSent,
  NanoClawPrincipalOutputReceived,
  EvaluationEvidenceSelected,
);

const gatewayObservation = Schema.Union(
  OpenClawPrincipalInstructionAttempted,
  OpenClawPrincipalFinalOutput,
  NanoClawPrincipalInputSent,
  NanoClawPrincipalOutputReceived,
);
type GatewayObservation = typeof gatewayObservation.Type;

/** One ordered principal-gateway observation and its ledger identity. */
export class GatewayEvidence extends Schema.Class<GatewayEvidence>(
  "GatewayEvidence",
)({
  eventId: evaluationEvidenceId,
  logicalSequence: Schema.NonNegativeInt,
  observation: gatewayObservation,
}) {}

/** Ordered gateway evidence for one run ledger. */
export class EvaluationEvidence extends Schema.Class<EvaluationEvidence>(
  "EvaluationEvidence",
)({
  caseId: evaluationCaseId,
  gateway: Schema.Array(GatewayEvidence),
  selectedEventIds: Schema.Array(evaluationEvidenceId),
}) {}

/** A ledger could not produce internally consistent evaluation evidence. */
export class EvaluationEvidenceProjectionError extends Schema.TaggedError<EvaluationEvidenceProjectionError>()(
  "EvaluationEvidenceProjectionError",
  { detail: Schema.NonEmptyString },
) {}

/** Ledger envelope fields consumed at the evaluation projection boundary. */
interface EvaluationEvidenceLedgerRecord {
  readonly eventId: string;
  readonly logicalSequence: number;
  readonly event: unknown;
}

/** Live and completed ledgers share this ordered evidence capability. */
export interface EvaluationEvidenceLedger<Failure = never> {
  readonly records: Stream.Stream<EvaluationEvidenceLedgerRecord, Failure>;
}

interface EvidenceRecord {
  readonly eventId: EvaluationEvidenceId;
  readonly logicalSequence: number;
  readonly event: unknown;
}

function projectionError(detail: string): EvaluationEvidenceProjectionError {
  return EvaluationEvidenceProjectionError.make({ detail });
}

function decodeEvidenceRecord(
  record: EvaluationEvidenceLedgerRecord,
): Effect.Effect<EvidenceRecord, EvaluationEvidenceProjectionError> {
  return Schema.decodeUnknown(evaluationEvidenceId)(record.eventId).pipe(
    Effect.mapError(() =>
      projectionError(
        `ledger eventId ${JSON.stringify(record.eventId)} is not a nonempty evaluation evidence identity`,
      ),
    ),
    Effect.map((eventId) => ({
      eventId,
      logicalSequence: record.logicalSequence,
      event: record.event,
    })),
  );
}

function isGatewayObservation(event: unknown): event is GatewayObservation {
  return (
    event instanceof OpenClawPrincipalInstructionAttempted ||
    event instanceof OpenClawPrincipalFinalOutput ||
    event instanceof NanoClawPrincipalInputSent ||
    event instanceof NanoClawPrincipalOutputReceived
  );
}

function isCustomerEvent(
  event: unknown,
): event is GatewayObservation | EvaluationEvidenceSelected {
  return (
    isGatewayObservation(event) || event instanceof EvaluationEvidenceSelected
  );
}

function evidenceCaseId(
  records: readonly EvidenceRecord[],
): Effect.Effect<
  typeof evaluationCaseId.Type,
  EvaluationEvidenceProjectionError
> {
  const caseIds = new Set<typeof evaluationCaseId.Type>();
  for (const record of records) {
    if (isCustomerEvent(record.event)) {
      caseIds.add(record.event.caseId);
    }
  }
  const [caseId] = caseIds;
  if (caseId === undefined) {
    return Effect.fail(
      projectionError("ledger contains no customer evaluation evidence"),
    );
  }
  return caseIds.size === 1
    ? Effect.succeed(caseId)
    : Effect.fail(
        projectionError("ledger contains customer evidence for multiple cases"),
      );
}

function gatewayEvidence(
  records: readonly EvidenceRecord[],
): readonly GatewayEvidence[] {
  return records.flatMap((record) =>
    isGatewayObservation(record.event)
      ? [
          GatewayEvidence.make({
            eventId: record.eventId,
            logicalSequence: record.logicalSequence,
            observation: record.event,
          }),
        ]
      : [],
  );
}

function selectedEvidenceIds(
  records: readonly EvidenceRecord[],
  gateway: readonly GatewayEvidence[],
): Effect.Effect<
  readonly EvaluationEvidenceId[],
  EvaluationEvidenceProjectionError
> {
  const selectable = new Set(gateway.map((evidence) => evidence.eventId));
  const positions = new Map(
    records.map((record, position) => [record.eventId, position]),
  );
  const selected = new Set<EvaluationEvidenceId>();
  const ordered: EvaluationEvidenceId[] = [];
  return Effect.gen(function* () {
    for (const [position, record] of records.entries()) {
      if (!(record.event instanceof EvaluationEvidenceSelected)) {
        continue;
      }
      const target = record.event.selectedEventId;
      const targetPosition = positions.get(target);
      if (!selectable.has(target) || targetPosition === undefined) {
        return yield* Effect.fail(
          projectionError(
            `selection ${record.eventId} references absent evidence ${target}`,
          ),
        );
      }
      if (targetPosition >= position) {
        return yield* Effect.fail(
          projectionError(
            `selection ${record.eventId} references evidence ${target} before it was observed`,
          ),
        );
      }
      if (selected.has(target)) {
        return yield* Effect.fail(
          projectionError(`evidence ${target} was selected more than once`),
        );
      }
      selected.add(target);
      ordered.push(target);
    }
    return ordered;
  });
}

/** Project exact native-gateway testimony in ledger order. */
export const projectEvaluationEvidence = Effect.fn(
  "evals.projectEvaluationEvidence",
)(function* <Failure>(ledger: EvaluationEvidenceLedger<Failure>) {
  const collected = yield* ledger.records.pipe(
    Stream.mapEffect(decodeEvidenceRecord),
    Stream.runCollect,
  );
  const records = Chunk.toReadonlyArray(collected);
  const caseId = yield* evidenceCaseId(records);
  const gateway = gatewayEvidence(records);
  const selected = yield* selectedEvidenceIds(records, gateway);
  return EvaluationEvidence.make({
    caseId,
    gateway,
    selectedEventIds: selected,
  });
});
