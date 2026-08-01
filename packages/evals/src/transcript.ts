/** @file Normalized evaluation transcripts and their evidence-ID invariants. */

import { conversationId } from "@moltzap/protocol/conversation";
import { type AgentId, agentId, agentName } from "@moltzap/protocol/identity";
import {
  type MessageParts,
  messagePartsSchema,
} from "@moltzap/protocol/message";
import { taskId } from "@moltzap/protocol/task";
import { OpenClawGatewayTimedOut } from "@moltzap/simulator/runtime";
import { Effect, Schema } from "effect";
import { TARGET_AGENT_NAME, type EvaluationCaseMetadata } from "./cases.js";
import {
  CodePeerMessageReceived,
  CodePeerMessageSent,
  type EvaluationEvidence,
  EvaluationEvidenceProjectionError,
  type EvaluationEvidenceLedger,
  type GatewayEvidence,
  NanoclawPrincipalInputSent,
  NanoclawPrincipalOutputReceived,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
  type PeerTimeoutEvidence,
  type SocialEvidence,
  projectEvaluationEvidence,
} from "./events.js";
import {
  type CriterionId,
  type EvaluationCaseId,
  type EvaluationEvidenceId,
  evaluationCaseId,
  evaluationEvidenceId,
  positiveInteger,
} from "./model.js";

const transcriptParts = messagePartsSchema();
const maximumPartLength = 32_768;
const maximumParts = 10;
const transcriptTruncationMarker = "\n[transcript truncated]";

/** Principal identity established by every native gateway observation. */
export class EvaluationTarget extends Schema.Class<EvaluationTarget>(
  "EvaluationTarget",
)({
  name: agentName,
  id: agentId,
}) {}

/** One normalized native principal-gateway input or output. */
export class GatewayTranscriptItem extends Schema.TaggedClass<GatewayTranscriptItem>()(
  "GatewayTranscriptItem",
  {
    evidenceId: evaluationEvidenceId,
    source: Schema.Literal("gateway"),
    direction: Schema.Literal("input", "output"),
    actorName: agentName,
    actorId: agentId,
    parts: transcriptParts,
  },
) {}

/** One normalized social observation with its router corroboration. */
export class SocialTranscriptItem extends Schema.TaggedClass<SocialTranscriptItem>()(
  "SocialTranscriptItem",
  {
    evidenceId: evaluationEvidenceId,
    source: Schema.Literal("social"),
    direction: Schema.Literal("input", "output"),
    actorName: Schema.optional(agentName),
    actorId: agentId,
    endpointName: agentName,
    endpointId: agentId,
    taskId: Schema.optional(taskId),
    conversationId,
    routerCommitEvidenceId: evaluationEvidenceId,
    parts: transcriptParts,
  },
) {}

/** A required autonomous peer exchange was absent at the policy deadline. */
export class PeerTimeoutTranscriptItem extends Schema.TaggedClass<PeerTimeoutTranscriptItem>()(
  "PeerTimeoutTranscriptItem",
  {
    evidenceId: evaluationEvidenceId,
    source: Schema.Literal("peer-timeout"),
    endpointName: agentName,
    endpointId: agentId,
    timeoutMillis: positiveInteger,
  },
) {}

/** Closed transcript item universe supplied to deterministic and semantic graders. */
const transcriptItem = Schema.Union(
  GatewayTranscriptItem,
  SocialTranscriptItem,
  PeerTimeoutTranscriptItem,
);

/** Ordered normalized evidence and the exact observations selected by the case. */
export class EvaluationTranscript extends Schema.Class<EvaluationTranscript>(
  "EvaluationTranscript",
)({
  caseId: evaluationCaseId,
  target: EvaluationTarget,
  items: Schema.NonEmptyArray(transcriptItem),
  selectedEvidenceIds: Schema.NonEmptyArray(evaluationEvidenceId),
}) {}

/** Invalid, incomplete, or definition-mismatched evidence is never scored. */
export class GradingRefused extends Schema.TaggedError<GradingRefused>()(
  "GradingRefused",
  {
    caseId: evaluationCaseId,
    detail: Schema.NonEmptyString,
  },
) {}

/** One reason a transcript, selection, or citation is unusable as evidence. */
export interface TranscriptIssue {
  readonly detail: string;
  readonly evidenceId?: EvaluationEvidenceId;
}

/**
 * Build the refusal that keeps unusable evidence out of every report.
 * @param caseId The case whose evidence cannot be scored.
 * @param detail Why the evidence is unusable.
 * @returns A refusal that ends the case without producing any verdict.
 */
export function refusal(
  caseId: EvaluationCaseId,
  detail: string,
): GradingRefused {
  return GradingRefused.make({ caseId, detail });
}

function duplicate<Value>(values: readonly Value[]): Value | undefined {
  const seen = new Set<Value>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

function nonemptyText(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? value : fallback;
}

/**
 * Normalize untrusted observed text into bounded transcript parts.
 * @param value Observed text; anything beyond the bound is dropped.
 * @param fallback Stands in when the text is blank or entirely whitespace.
 * @returns Between one and `maximumParts` parts, overlong text ending in the
 * truncation marker.
 */
export function textParts(value: string, fallback: string): MessageParts {
  const normalized = nonemptyText(value, fallback);
  const maximumLength = maximumPartLength * maximumParts;
  const text =
    normalized.length <= maximumLength
      ? normalized
      : `${normalized.slice(
          0,
          maximumLength - transcriptTruncationMarker.length,
        )}${transcriptTruncationMarker}`;
  const parts: Array<{ readonly type: "text"; readonly text: string }> = [];
  for (
    let offset = 0;
    offset < text.length && parts.length < maximumParts;
    offset += maximumPartLength
  ) {
    parts.push({
      type: "text",
      text: text.slice(offset, offset + maximumPartLength),
    });
  }
  const [first, ...remaining] = parts;
  return first === undefined
    ? [{ type: "text", text: fallback }]
    : [first, ...remaining];
}

function openClawOutputText(observation: OpenClawPrincipalFinalOutput): string {
  const payloads = observation.output.result?.payloads ?? [];
  const fragments = payloads.flatMap((payload) => {
    if (payload.isReasoning === true) {
      return [];
    }
    const values: string[] = [];
    if (payload.text !== undefined) {
      values.push(payload.text);
    }
    if (payload.mediaUrl !== undefined) {
      values.push(`[media: ${payload.mediaUrl}]`);
    }
    for (const mediaUrl of payload.mediaUrls ?? []) {
      values.push(`[media: ${mediaUrl}]`);
    }
    return values;
  });
  if (fragments.length > 0) {
    return fragments.join("\n");
  }
  return observation.output instanceof OpenClawGatewayTimedOut
    ? "[OpenClaw timed out without principal output]"
    : "[OpenClaw completed without principal output]";
}

function gatewayParts(
  observation: GatewayEvidence["observation"],
): MessageParts {
  if (observation instanceof OpenClawPrincipalInstructionAttempted) {
    return textParts(
      observation.request.message,
      "[Empty OpenClaw principal instruction]",
    );
  }
  if (observation instanceof OpenClawPrincipalFinalOutput) {
    return textParts(
      openClawOutputText(observation),
      "[OpenClaw returned no principal output]",
    );
  }
  if (observation instanceof NanoclawPrincipalInputSent) {
    return textParts(
      observation.input.text,
      "[Empty NanoClaw principal input]",
    );
  }
  return textParts(
    observation.output.text,
    "[NanoClaw returned an empty principal output frame]",
  );
}

function isGatewayOutput(
  observation: GatewayEvidence["observation"],
): observation is
  | OpenClawPrincipalFinalOutput
  | NanoclawPrincipalOutputReceived {
  return (
    observation instanceof OpenClawPrincipalFinalOutput ||
    observation instanceof NanoclawPrincipalOutputReceived
  );
}

function isSelectableGatewayOutput(
  observation: GatewayEvidence["observation"],
): observation is OpenClawPrincipalFinalOutput {
  return observation instanceof OpenClawPrincipalFinalOutput;
}

function targetFromGateway(
  evidence: EvaluationEvidence,
): Effect.Effect<EvaluationTarget, GradingRefused> {
  const identities = new Map<string, EvaluationTarget>();
  for (const item of evidence.gateway) {
    const { agentId: id, agentName: name } = item.observation;
    identities.set(`${name}\u0000${id}`, EvaluationTarget.make({ name, id }));
  }
  const [target] = identities.values();
  if (identities.size !== 1 || target === undefined) {
    return Effect.fail(
      refusal(
        evidence.caseId,
        "native gateway evidence must establish exactly one target identity",
      ),
    );
  }
  if (target.name !== TARGET_AGENT_NAME) {
    return Effect.fail(
      refusal(
        evidence.caseId,
        `native gateway evidence identifies ${target.name}, not ${TARGET_AGENT_NAME}`,
      ),
    );
  }
  return Effect.succeed(target);
}

function gatewayItem(item: GatewayEvidence): GatewayTranscriptItem {
  const observation = item.observation;
  return GatewayTranscriptItem.make({
    evidenceId: item.eventId,
    source: "gateway",
    direction: isGatewayOutput(observation) ? "output" : "input",
    actorName: observation.agentName,
    actorId: observation.agentId,
    parts: gatewayParts(observation),
  });
}

function socialSender(item: SocialEvidence): AgentId {
  return item.observation instanceof CodePeerMessageSent
    ? item.observation.agentId
    : item.observation.senderId;
}

function socialSenderName(
  item: SocialEvidence,
  target: EvaluationTarget,
): SocialTranscriptItem["actorName"] {
  if (item.observation instanceof CodePeerMessageSent) {
    return item.observation.agentName;
  }
  return item.observation.senderId === target.id ? target.name : undefined;
}

function socialItem(
  item: SocialEvidence,
  target: EvaluationTarget,
): SocialTranscriptItem {
  const observation = item.observation;
  const senderId = socialSender(item);
  const senderName = socialSenderName(item, target);
  return SocialTranscriptItem.make({
    evidenceId: item.eventId,
    source: "social",
    direction: senderId === target.id ? "output" : "input",
    actorId: senderId,
    ...(senderName === undefined ? {} : { actorName: senderName }),
    endpointName: observation.agentName,
    endpointId: observation.agentId,
    ...(observation.taskId === undefined ? {} : { taskId: observation.taskId }),
    conversationId: observation.conversationId,
    routerCommitEvidenceId: item.routerCommitEventId,
    parts: observation.parts,
  });
}

function peerTimeoutItem(item: PeerTimeoutEvidence): PeerTimeoutTranscriptItem {
  return PeerTimeoutTranscriptItem.make({
    evidenceId: item.eventId,
    source: "peer-timeout",
    endpointName: item.observation.agentName,
    endpointId: item.observation.agentId,
    timeoutMillis: item.observation.timeoutMillis,
  });
}

function selectedSocialIssue(
  item: SocialEvidence,
  target: EvaluationTarget,
): TranscriptIssue | undefined {
  if (!(item.observation instanceof CodePeerMessageReceived)) {
    return {
      detail:
        "selected social evidence must be a code peer's observation of target output",
      evidenceId: item.eventId,
    };
  }
  if (
    item.observation.senderId !== target.id ||
    item.routerCommit.senderId !== target.id
  ) {
    return {
      detail:
        "selected social evidence sender and router commit must both identify the target",
      evidenceId: item.eventId,
    };
  }
  return undefined;
}

function selectedGatewayIssue(
  item: GatewayEvidence,
  target: EvaluationTarget,
): TranscriptIssue | undefined {
  if (
    !isSelectableGatewayOutput(item.observation) ||
    item.observation.agentId !== target.id ||
    item.observation.agentName !== target.name
  ) {
    return {
      detail:
        "selected gateway evidence must be correlated terminal output from the target",
      evidenceId: item.eventId,
    };
  }
  return undefined;
}

function selectedEvidenceIssue(
  evidence: EvaluationEvidence,
  target: EvaluationTarget,
): TranscriptIssue | undefined {
  if (evidence.selectedEventIds.length === 0) {
    return { detail: "the case selected no evidence for grading" };
  }
  const repeated = duplicate(evidence.selectedEventIds);
  if (repeated !== undefined) {
    return {
      detail: `evidence ${repeated} was selected more than once`,
      evidenceId: repeated,
    };
  }
  for (const selectedId of evidence.selectedEventIds) {
    const issue = selectedEvidenceItemIssue(evidence, target, selectedId);
    if (issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}

function selectedEvidenceItemIssue(
  evidence: EvaluationEvidence,
  target: EvaluationTarget,
  selectedId: EvaluationEvidenceId,
): TranscriptIssue | undefined {
  const gateway = evidence.gateway.find((item) => item.eventId === selectedId);
  if (gateway !== undefined) {
    return selectedGatewayIssue(gateway, target);
  }
  const social = evidence.social.find((item) => item.eventId === selectedId);
  if (social !== undefined) {
    return selectedSocialIssue(social, target);
  }
  const timeout = evidence.peerTimeouts.find(
    (item) => item.eventId === selectedId,
  );
  if (timeout !== undefined) {
    return undefined;
  }
  return {
    detail: `selected evidence ${selectedId} is absent`,
    evidenceId: selectedId,
  };
}

function transcriptFromEvidence(
  evidence: EvaluationEvidence,
  definition: EvaluationCaseMetadata,
): Effect.Effect<EvaluationTranscript, GradingRefused> {
  return Effect.gen(function* () {
    if (evidence.caseId !== definition.id) {
      return yield* Effect.fail(
        refusal(
          evidence.caseId,
          `case definition ${definition.id} does not match evidence ${evidence.caseId}`,
        ),
      );
    }
    const target = yield* targetFromGateway(evidence);
    const selectionIssue = selectedEvidenceIssue(evidence, target);
    if (selectionIssue !== undefined) {
      return yield* Effect.fail(
        refusal(evidence.caseId, selectionIssue.detail),
      );
    }
    const items = [
      ...evidence.gateway.map((item) => ({
        logicalSequence: item.logicalSequence,
        value: gatewayItem(item),
      })),
      ...evidence.social.map((item) => ({
        logicalSequence: item.logicalSequence,
        value: socialItem(item, target),
      })),
      ...evidence.peerTimeouts.map((item) => ({
        logicalSequence: item.logicalSequence,
        value: peerTimeoutItem(item),
      })),
    ].sort((left, right) => left.logicalSequence - right.logicalSequence);
    const [firstItem, ...remainingItems] = items;
    const [firstSelection, ...remainingSelections] = evidence.selectedEventIds;
    if (firstItem === undefined || firstSelection === undefined) {
      return yield* Effect.fail(
        refusal(evidence.caseId, "evaluation evidence is incomplete"),
      );
    }
    return EvaluationTranscript.make({
      caseId: evidence.caseId,
      target,
      items: [firstItem.value, ...remainingItems.map(({ value }) => value)],
      selectedEvidenceIds: [firstSelection, ...remainingSelections],
    });
  });
}

/**
 * Project a completed ledger, establish its native target, and normalize the
 * selected principal output without inventing message correlation.
 */
export const transcriptFromLedger = Effect.fn("evals.transcriptFromLedger")(
  function* <Failure>(
    ledger: EvaluationEvidenceLedger<Failure>,
    definition: EvaluationCaseMetadata,
  ) {
    const evidence = yield* projectEvaluationEvidence(ledger).pipe(
      Effect.mapError((error) =>
        error instanceof EvaluationEvidenceProjectionError
          ? refusal(definition.id, error.detail)
          : error,
      ),
    );
    return yield* transcriptFromEvidence(evidence, definition);
  },
);

function selectedTranscriptItemIssue(
  transcript: EvaluationTranscript,
  selectedId: EvaluationEvidenceId,
): TranscriptIssue | undefined {
  const selected = transcript.items.find(
    (item) => item.evidenceId === selectedId,
  );
  if (selected === undefined) {
    return {
      detail: `selected evidence ${selectedId} is absent from the transcript`,
      evidenceId: selectedId,
    };
  }
  // A peer timeout records an absence of output, so it carries no direction or actor.
  if (selected instanceof PeerTimeoutTranscriptItem) {
    return undefined;
  }
  if (
    selected.direction !== "output" ||
    selected.actorId !== transcript.target.id
  ) {
    return {
      detail: `selected evidence ${selectedId} is not target output`,
      evidenceId: selectedId,
    };
  }
  return undefined;
}

/**
 * Report the first structural defect in a transcript.
 * @param transcript Normalized evidence and the observations the case selected.
 * @returns The defect that disqualifies the transcript, or undefined when every
 * selected observation resolves to target output.
 */
export function transcriptIssue(
  transcript: EvaluationTranscript,
): TranscriptIssue | undefined {
  const repeatedItem = duplicate(
    transcript.items.map((item) => item.evidenceId),
  );
  if (repeatedItem !== undefined) {
    return {
      detail: `transcript repeats evidence ${repeatedItem}`,
      evidenceId: repeatedItem,
    };
  }
  const repeatedSelection = duplicate(transcript.selectedEvidenceIds);
  if (repeatedSelection !== undefined) {
    return {
      detail: `transcript repeats selected evidence ${repeatedSelection}`,
      evidenceId: repeatedSelection,
    };
  }
  for (const selectedId of transcript.selectedEvidenceIds) {
    const issue = selectedTranscriptItemIssue(transcript, selectedId);
    if (issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}

/** Refuse a structurally defective transcript before anything scores it. */
export const validateEvaluationTranscript = Effect.fn(
  "evals.validateEvaluationTranscript",
)(function* (transcript: EvaluationTranscript) {
  const issue = transcriptIssue(transcript);
  if (issue !== undefined) {
    return yield* Effect.fail(refusal(transcript.caseId, issue.detail));
  }
  return transcript;
});

/**
 * Report why one criterion's citations fail to bind to transcript evidence.
 * @param transcript Normalized evidence and the observations the case selected.
 * @param criterion Named in the reported detail; nothing else reads it.
 * @param citations Evidence IDs the decision offers as proof.
 * @returns The binding failure, or undefined when the citations are unique, all
 * present in the transcript, and include at least one selected observation.
 */
export function citationIssue(
  transcript: EvaluationTranscript,
  criterion: CriterionId,
  citations: readonly EvaluationEvidenceId[],
): TranscriptIssue | undefined {
  if (citations.length === 0) {
    return { detail: `criterion ${criterion} has no evidence citation` };
  }
  const repeated = duplicate(citations);
  if (repeated !== undefined) {
    return {
      detail: `criterion ${criterion} repeats evidence citation ${repeated}`,
      evidenceId: repeated,
    };
  }
  const available = new Set(transcript.items.map((item) => item.evidenceId));
  for (const citation of citations) {
    if (!available.has(citation)) {
      return {
        detail: `criterion ${criterion} cites evidence outside the transcript`,
        evidenceId: citation,
      };
    }
  }
  const selected = new Set(transcript.selectedEvidenceIds);
  if (!citations.some((citation) => selected.has(citation))) {
    return {
      detail: `criterion ${criterion} does not cite selected target output`,
    };
  }
  return undefined;
}
