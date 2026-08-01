/** @file Evaluation events and typed simulator evidence projections. */

import { conversationId, messageId } from "@moltzap/protocol/conversation";
import { type AgentId, agentId, agentName } from "@moltzap/protocol/identity";
import { messagePartsSchema } from "@moltzap/protocol/message";
import { taskId } from "@moltzap/protocol/task";
import { EventCatalog, RouterMessageCommitted } from "@moltzap/simulator";
import {
  NanoclawGatewayInput,
  NanoclawGatewayOutput,
  OpenClawGatewayRequest,
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
} from "@moltzap/simulator/runtime";
import { Chunk, Effect, Schema, Stream } from "effect";
import {
  evaluationCaseId,
  evaluationEvidenceId,
  type EvaluationEvidenceId,
} from "./model.js";

const messageParts = messagePartsSchema();
const openClawGatewayResponse = Schema.Union(
  OpenClawGatewaySucceeded,
  OpenClawGatewayTimedOut,
);

/**
 * The evaluation adapter durably recorded its intent immediately before
 * submitting an instruction to OpenClaw's native principal gateway.
 */
export class OpenClawPrincipalInstructionAttempted extends Schema.TaggedClass<OpenClawPrincipalInstructionAttempted>()(
  "moltzap.openclaw-principal-instruction-attempted/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    request: OpenClawGatewayRequest,
  },
) {}

/** OpenClaw's native principal gateway returned its terminal output. */
export class OpenClawPrincipalFinalOutput extends Schema.TaggedClass<OpenClawPrincipalFinalOutput>()(
  "moltzap.openclaw-principal-final-output/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    idempotencyKey: Schema.NonEmptyString,
    output: openClawGatewayResponse,
  },
) {}

/** The evaluation adapter sent one input frame to NanoClaw's principal socket. */
export class NanoclawPrincipalInputSent extends Schema.TaggedClass<NanoclawPrincipalInputSent>()(
  "moltzap.nanoclaw-principal-input-sent/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    input: NanoclawGatewayInput,
  },
) {}

/** The evaluation adapter received one output frame from NanoClaw. */
export class NanoclawPrincipalOutputReceived extends Schema.TaggedClass<NanoclawPrincipalOutputReceived>()(
  "moltzap.nanoclaw-principal-output-received/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    output: NanoclawGatewayOutput,
  },
) {}

/**
 * A code peer testifies to content it sent through its production protocol
 * client. The router commit independently corroborates durable transmission.
 */
export class CodePeerMessageSent extends Schema.TaggedClass<CodePeerMessageSent>()(
  "moltzap.code-peer-message-sent/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    taskId: Schema.optional(taskId),
    conversationId: conversationId,
    messageId: messageId,
    parts: messageParts,
  },
) {}

/**
 * A code peer testifies to content delivered through its production protocol
 * client. The sender remains independently corroborated by the router.
 */
export class CodePeerMessageReceived extends Schema.TaggedClass<CodePeerMessageReceived>()(
  "moltzap.code-peer-message-received/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    taskId: Schema.optional(taskId),
    conversationId: conversationId,
    messageId: messageId,
    senderId: agentId,
    parts: messageParts,
  },
) {}

/** A bounded peer policy produced no complete exchange before its deadline. */
export class PeerExchangeNotObserved extends Schema.TaggedClass<PeerExchangeNotObserved>()(
  "moltzap.peer-exchange-not-observed/v1",
  {
    caseId: evaluationCaseId,
    agentName: agentName,
    agentId: agentId,
    timeoutMillis: Schema.Int.pipe(Schema.positive()),
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
  NanoclawPrincipalInputSent,
  NanoclawPrincipalOutputReceived,
  CodePeerMessageSent,
  CodePeerMessageReceived,
  PeerExchangeNotObserved,
  EvaluationEvidenceSelected,
);

const gatewayObservation = Schema.Union(
  OpenClawPrincipalInstructionAttempted,
  OpenClawPrincipalFinalOutput,
  NanoclawPrincipalInputSent,
  NanoclawPrincipalOutputReceived,
);
type GatewayObservation = typeof gatewayObservation.Type;

const socialObservation = Schema.Union(
  CodePeerMessageSent,
  CodePeerMessageReceived,
);
type SocialObservation = typeof socialObservation.Type;

/** One ordered principal-gateway observation and its ledger identity. */
export class GatewayEvidence extends Schema.Class<GatewayEvidence>(
  "GatewayEvidence",
)({
  eventId: evaluationEvidenceId,
  logicalSequence: Schema.NonNegativeInt,
  observation: gatewayObservation,
}) {}

/**
 * Endpoint testimony paired with the content-blind router commit that proves
 * the same sender and message became durable.
 */
export class SocialEvidence extends Schema.Class<SocialEvidence>(
  "SocialEvidence",
)({
  eventId: evaluationEvidenceId,
  logicalSequence: Schema.NonNegativeInt,
  observation: socialObservation,
  routerCommitEventId: evaluationEvidenceId,
  routerCommit: RouterMessageCommitted,
}) {}

/** One bounded peer observation that completed without an exchange. */
export class PeerTimeoutEvidence extends Schema.Class<PeerTimeoutEvidence>(
  "PeerTimeoutEvidence",
)({
  eventId: evaluationEvidenceId,
  logicalSequence: Schema.NonNegativeInt,
  observation: PeerExchangeNotObserved,
}) {}

/** Ordered gateway, social, and bounded-absence evidence for one run ledger. */
export class EvaluationEvidence extends Schema.Class<EvaluationEvidence>(
  "EvaluationEvidence",
)({
  caseId: evaluationCaseId,
  gateway: Schema.Array(GatewayEvidence),
  social: Schema.Array(SocialEvidence),
  peerTimeouts: Schema.Array(PeerTimeoutEvidence),
  selectedEventIds: Schema.Array(evaluationEvidenceId),
}) {}

/** A ledger could not produce internally corroborated evaluation evidence. */
export class EvaluationEvidenceProjectionError extends Schema.TaggedError<EvaluationEvidenceProjectionError>()(
  "EvaluationEvidenceProjectionError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** Ledger envelope fields consumed at the evaluation projection boundary. */
export interface EvaluationEvidenceLedgerRecord {
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

interface RouterCommitRecord extends EvidenceRecord {
  readonly event: RouterMessageCommitted;
}

interface SocialObservationRecord extends EvidenceRecord {
  readonly event: SocialObservation;
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
    event instanceof NanoclawPrincipalInputSent ||
    event instanceof NanoclawPrincipalOutputReceived
  );
}

function isSocialObservation(event: unknown): event is SocialObservation {
  return (
    event instanceof CodePeerMessageSent ||
    event instanceof CodePeerMessageReceived
  );
}

function isCustomerEvent(
  event: unknown,
): event is
  | GatewayObservation
  | SocialObservation
  | PeerExchangeNotObserved
  | EvaluationEvidenceSelected {
  return (
    isGatewayObservation(event) ||
    isSocialObservation(event) ||
    event instanceof PeerExchangeNotObserved ||
    event instanceof EvaluationEvidenceSelected
  );
}

function evidenceCaseId(
  records: readonly EvidenceRecord[],
): Effect.Effect<
  typeof evaluationCaseId.Type,
  EvaluationEvidenceProjectionError
> {
  const caseIds = new Set(
    records
      .filter(
        (
          record,
        ): record is EvidenceRecord & {
          readonly event:
            | GatewayObservation
            | SocialObservation
            | PeerExchangeNotObserved
            | EvaluationEvidenceSelected;
        } => isCustomerEvent(record.event),
      )
      .map((record) => record.event.caseId),
  );
  const [caseId] = caseIds;
  if (caseId === undefined) {
    return Effect.fail(
      projectionError("ledger contains no customer evaluation evidence"),
    );
  }
  if (caseIds.size !== 1) {
    return Effect.fail(
      projectionError("ledger contains customer evidence for multiple cases"),
    );
  }
  return Effect.succeed(caseId);
}

function messageKey(event: SocialObservation | RouterMessageCommitted): string {
  return JSON.stringify([event.conversationId, event.messageId]);
}

function routerCommits(
  records: readonly EvidenceRecord[],
): Map<string, RouterCommitRecord[]> {
  const commits = new Map<string, RouterCommitRecord[]>();
  for (const record of records) {
    if (!(record.event instanceof RouterMessageCommitted)) {
      continue;
    }
    const committed: RouterCommitRecord = {
      ...record,
      event: record.event,
    };
    const key = messageKey(committed.event);
    const matching = commits.get(key);
    if (matching === undefined) {
      commits.set(key, [committed]);
    } else {
      matching.push(committed);
    }
  }
  return commits;
}

function gatewayEvidence(
  records: readonly EvidenceRecord[],
): readonly GatewayEvidence[] {
  const evidence: GatewayEvidence[] = [];
  for (const record of records) {
    if (!isGatewayObservation(record.event)) {
      continue;
    }
    evidence.push(
      GatewayEvidence.make({
        eventId: record.eventId,
        logicalSequence: record.logicalSequence,
        observation: record.event,
      }),
    );
  }
  return evidence;
}

function socialObservationSender(observation: SocialObservation): AgentId {
  return observation instanceof CodePeerMessageSent
    ? observation.agentId
    : observation.senderId;
}

function corroborateSocialObservation(
  record: SocialObservationRecord,
  commits: Map<string, RouterCommitRecord[]>,
): Effect.Effect<SocialEvidence, EvaluationEvidenceProjectionError> {
  const matching = commits.get(messageKey(record.event)) ?? [];
  const [commit] = matching;
  if (matching.length !== 1 || commit === undefined) {
    return Effect.fail(
      projectionError(
        `social observation ${record.eventId} requires exactly one router commit`,
      ),
    );
  }
  if (commit.event.senderId !== socialObservationSender(record.event)) {
    return Effect.fail(
      projectionError(
        `social observation ${record.eventId} disagrees with router sender ${commit.event.senderId}`,
      ),
    );
  }
  return Effect.succeed(
    SocialEvidence.make({
      eventId: record.eventId,
      logicalSequence: record.logicalSequence,
      observation: record.event,
      routerCommitEventId: commit.eventId,
      routerCommit: commit.event,
    }),
  );
}

function socialEvidence(
  records: readonly EvidenceRecord[],
): Effect.Effect<readonly SocialEvidence[], EvaluationEvidenceProjectionError> {
  const commits = routerCommits(records);
  const observations: SocialObservationRecord[] = [];
  for (const record of records) {
    if (!isSocialObservation(record.event)) {
      continue;
    }
    observations.push({ ...record, event: record.event });
  }
  return Effect.forEach(
    observations,
    (record) => corroborateSocialObservation(record, commits),
    { concurrency: 1 },
  );
}

function peerTimeoutEvidence(
  records: readonly EvidenceRecord[],
): readonly PeerTimeoutEvidence[] {
  return records.flatMap((record) =>
    record.event instanceof PeerExchangeNotObserved
      ? [
          PeerTimeoutEvidence.make({
            eventId: record.eventId,
            logicalSequence: record.logicalSequence,
            observation: record.event,
          }),
        ]
      : [],
  );
}

interface SelectionValidation {
  readonly position: number;
  readonly selectable: ReadonlySet<EvaluationEvidenceId>;
  readonly positions: ReadonlyMap<EvaluationEvidenceId, number>;
  readonly selected: ReadonlySet<EvaluationEvidenceId>;
}

function validateSelection(
  record: EvidenceRecord & { readonly event: EvaluationEvidenceSelected },
  validation: SelectionValidation,
): Effect.Effect<EvaluationEvidenceId, EvaluationEvidenceProjectionError> {
  const target = record.event.selectedEventId;
  const targetPosition = validation.positions.get(target);
  if (!validation.selectable.has(target) || targetPosition === undefined) {
    return Effect.fail(
      projectionError(
        `selection ${record.eventId} references absent evidence ${target}`,
      ),
    );
  }
  if (targetPosition >= validation.position) {
    return Effect.fail(
      projectionError(
        `selection ${record.eventId} references evidence ${target} before it was observed`,
      ),
    );
  }
  if (validation.selected.has(target)) {
    return Effect.fail(
      projectionError(`evidence ${target} was selected more than once`),
    );
  }
  return Effect.succeed(target);
}

function selectedEvidenceIds(
  records: readonly EvidenceRecord[],
  gateway: readonly GatewayEvidence[],
  social: readonly SocialEvidence[],
  peerTimeouts: readonly PeerTimeoutEvidence[],
): Effect.Effect<
  readonly EvaluationEvidenceId[],
  EvaluationEvidenceProjectionError
> {
  const selectable = new Set<EvaluationEvidenceId>([
    ...gateway.map((evidence) => evidence.eventId),
    ...social.map((evidence) => evidence.eventId),
    ...peerTimeouts.map((evidence) => evidence.eventId),
  ]);
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
      const target = yield* validateSelection(
        { ...record, event: record.event },
        { position, selectable, positions, selected },
      );
      selected.add(target);
      ordered.push(target);
    }
    return ordered;
  });
}

/**
 * Project exact gateway testimony and router-corroborated social testimony in
 * ledger order.
 */
export const projectEvaluationEvidence = Effect.fn(
  "evals.projectEvaluationEvidence",
)(function* <Failure>(ledger: EvaluationEvidenceLedger<Failure>) {
  const collected = yield* ledger.records.pipe(
    Stream.mapEffect(decodeEvidenceRecord),
    Stream.runCollect,
  );
  const records = Chunk.toReadonlyArray(collected);
  const caseId = yield* evidenceCaseId(records);
  const social = yield* socialEvidence(records);
  const gateway = gatewayEvidence(records);
  const peerTimeouts = peerTimeoutEvidence(records);
  const selectedEventIds = yield* selectedEvidenceIds(
    records,
    gateway,
    social,
    peerTimeouts,
  );
  return EvaluationEvidence.make({
    caseId,
    gateway,
    social,
    peerTimeouts,
    selectedEventIds,
  });
});
