/** @file Normalized evaluation transcripts and their evidence-ID invariants. */

import { AgentAddress, GroupAddress } from "@moltzap/client";
import { OpenClawGatewayTimedOut } from "@moltzap/simulator/agents";
import { Effect, Schema } from "effect";
import { type EvaluationCaseMetadata, TARGET_AGENT_NAME } from "./cases.js";
import {
  type EvaluationEvidence,
  type EvaluationEvidenceLedger,
  EvaluationEvidenceProjectionError,
  type GatewayEvidence,
  NanoClawPrincipalInputSent,
  NanoClawPrincipalOutputReceived,
  OpenClawPrincipalFinalOutput,
  OpenClawPrincipalInstructionAttempted,
  projectEvaluationEvidence,
  semanticContent,
  SocialActionNotObserved,
  SocialActionObserved,
  type SocialEvidence,
} from "./events.js";
import {
  type CriterionId,
  type EvaluationCaseId,
  evaluationCaseId,
  type EvaluationEvidenceId,
  evaluationEvidenceId,
} from "./model.js";

const transcriptParts = Schema.NonEmptyArray(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);
const agentName = Schema.NonEmptyString;
const canonicalMessageAddress = Schema.Union(AgentAddress, GroupAddress);
type TranscriptParts = typeof transcriptParts.Type;
const maximumPartLength = 32_768;
const maximumParts = 10;
const transcriptTruncationMarker = "\n[transcript truncated]";

/** Principal identity established by every native gateway observation. */
export class EvaluationTarget extends Schema.Class<EvaluationTarget>(
  "EvaluationTarget",
)({ name: agentName }) {}

/** One normalized native principal-gateway input or output. */
export class GatewayTranscriptItem extends Schema.TaggedClass<GatewayTranscriptItem>()(
  "GatewayTranscriptItem",
  {
    evidenceId: evaluationEvidenceId,
    source: Schema.Literal("gateway"),
    direction: Schema.Literal("input", "output"),
    actorName: agentName,
    parts: transcriptParts,
  },
) {}

/** One semantic action observed through a peer's public HarnessEndpoint. */
export class SocialTranscriptItem extends Schema.TaggedClass<SocialTranscriptItem>()(
  "SocialTranscriptItem",
  {
    evidenceId: evaluationEvidenceId,
    source: Schema.Literal("social"),
    direction: Schema.Literal("input", "output"),
    actorName: agentName,
    endpointName: agentName,
    address: canonicalMessageAddress,
    parts: semanticContent,
  },
) {}

/** Bounded evidence that a required social response never arrived. */
export class PeerTimeoutTranscriptItem extends Schema.TaggedClass<PeerTimeoutTranscriptItem>()(
  "PeerTimeoutTranscriptItem",
  {
    evidenceId: evaluationEvidenceId,
    source: Schema.Literal("peer-timeout"),
    direction: Schema.Literal("input"),
    actorName: agentName,
    endpointName: agentName,
    parts: transcriptParts,
  },
) {}

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
  { caseId: evaluationCaseId, detail: Schema.NonEmptyString },
) {}

/** One reason a transcript, selection, or citation is unusable as evidence. */
export interface TranscriptIssue {
  readonly detail: string;
  readonly evidenceId?: EvaluationEvidenceId;
}

/**
 * Build the refusal that keeps unusable evidence out of every report.
 * @param caseId Case whose evidence cannot be graded.
 * @param detail Stable explanation of the evidence defect.
 * @returns The typed refusal retained by the evaluation attempt.
 */
export function refusal(
  caseId: EvaluationCaseId,
  detail: string,
): GradingRefused {
  return GradingRefused.make({ caseId, detail });
}

/**
 * Normalize untrusted observed text into bounded transcript parts.
 * @param value Observed text to retain when it is nonempty.
 * @param fallback Text used when the observation is empty.
 * @returns Nonempty bounded text parts suitable for a transcript item.
 */
export function textParts(value: string, fallback: string): TranscriptParts {
  const normalized = value.trim().length > 0 ? value : fallback;
  const maximumLength = maximumPartLength * maximumParts;
  const text =
    normalized.length <= maximumLength
      ? normalized
      : `${normalized.slice(0, maximumLength - transcriptTruncationMarker.length)}${transcriptTruncationMarker}`;
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

/**
 * Report the first structural defect in a transcript.
 * @param transcript Normalized transcript to inspect.
 * @returns The first structural issue, or `undefined` when the transcript is valid.
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
    const issue = selectedTranscriptIssue(transcript, selectedId);
    if (issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}

/**
 * Report why one criterion's citations fail to bind to transcript evidence.
 * @param transcript Transcript that owns the available and selected evidence.
 * @param criterion Criterion whose citations are inspected.
 * @param citations Evidence identifiers returned for the criterion.
 * @returns The first citation issue, or `undefined` when citations are valid.
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
  return citations.some((citation) => selected.has(citation))
    ? undefined
    : { detail: `criterion ${criterion} does not cite selected target output` };
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

function selectedEvidenceItemIssue(
  evidence: EvaluationEvidence,
  target: EvaluationTarget,
  selectedId: EvaluationEvidenceId,
): TranscriptIssue | undefined {
  const gatewaySelection = evidence.gateway.find(
    (item) => item.eventId === selectedId,
  );
  if (gatewaySelection !== undefined) {
    return selectedGatewayIssue(selectedId, gatewaySelection, target);
  }
  const socialSelection = evidence.social.find(
    (item) => item.eventId === selectedId,
  );
  return selectedSocialIssue(selectedId, target, socialSelection);
}

function selectedGatewayIssue(
  selectedId: EvaluationEvidenceId,
  selection: GatewayEvidence,
  target: EvaluationTarget,
): TranscriptIssue | undefined {
  const isTargetOutput =
    isGatewayOutput(selection.observation) &&
    selection.observation.agentName === target.name;
  return isTargetOutput
    ? undefined
    : {
        detail: `selected evidence ${selectedId} is not output from the target`,
        evidenceId: selectedId,
      };
}

function selectedSocialIssue(
  selectedId: EvaluationEvidenceId,
  target: EvaluationTarget,
  selection?: SocialEvidence,
): TranscriptIssue | undefined {
  if (selection?.observation instanceof SocialActionNotObserved) {
    return undefined;
  }
  const isTargetInput =
    selection?.observation instanceof SocialActionObserved &&
    selection.observation.direction === "input" &&
    agentNameFromAddress(selection.observation.authorAddress) === target.name;
  return isTargetInput
    ? undefined
    : {
        detail: `selected evidence ${selectedId} is neither target output nor a bounded peer timeout`,
        evidenceId: selectedId,
      };
}

function selectedTranscriptIssue(
  transcript: EvaluationTranscript,
  selectedId: EvaluationEvidenceId,
): TranscriptIssue | undefined {
  const selected = transcript.items.find(
    (item) => item.evidenceId === selectedId,
  );
  return selected !== undefined &&
    isSelectedTranscriptItem(selected, transcript)
    ? undefined
    : {
        detail: `selected evidence ${selectedId} is not target output`,
        evidenceId: selectedId,
      };
}

function isSelectedTranscriptItem(
  selected:
    | GatewayTranscriptItem
    | SocialTranscriptItem
    | PeerTimeoutTranscriptItem,
  transcript: EvaluationTranscript,
): boolean {
  if (selected instanceof GatewayTranscriptItem) {
    return (
      selected.direction === "output" &&
      selected.actorName === transcript.target.name
    );
  }
  if (selected instanceof SocialTranscriptItem) {
    return (
      selected.direction === "input" &&
      selected.actorName === transcript.target.name
    );
  }
  return selected instanceof PeerTimeoutTranscriptItem;
}

function gatewayItem(item: GatewayEvidence): GatewayTranscriptItem {
  return GatewayTranscriptItem.make({
    evidenceId: item.eventId,
    source: "gateway",
    direction: isGatewayOutput(item.observation) ? "output" : "input",
    actorName: item.observation.agentName,
    parts: gatewayParts(item.observation),
  });
}

function gatewayParts(
  observation: GatewayEvidence["observation"],
): TranscriptParts {
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
  if (observation instanceof NanoClawPrincipalInputSent) {
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

function openClawOutputText(observation: OpenClawPrincipalFinalOutput): string {
  const fragments = (observation.output.result?.payloads ?? []).flatMap(
    (payload) => {
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
    },
  );
  if (fragments.length > 0) {
    return fragments.join("\n");
  }
  return observation.output instanceof OpenClawGatewayTimedOut
    ? "[OpenClaw timed out without principal output]"
    : "[OpenClaw completed without principal output]";
}

function isGatewayOutput(
  observation: GatewayEvidence["observation"],
): observation is
  | OpenClawPrincipalFinalOutput
  | NanoClawPrincipalOutputReceived {
  return (
    observation instanceof OpenClawPrincipalFinalOutput ||
    observation instanceof NanoClawPrincipalOutputReceived
  );
}

function targetFromGateway(
  evidence: EvaluationEvidence,
): Effect.Effect<EvaluationTarget, GradingRefused> {
  const names = new Set(
    evidence.gateway.map((item) => item.observation.agentName),
  );
  const [name] = names;
  if (names.size !== 1 || name === undefined) {
    return Effect.fail(
      refusal(
        evidence.caseId,
        "native gateway evidence must establish exactly one target identity",
      ),
    );
  }
  if (name !== TARGET_AGENT_NAME) {
    return Effect.fail(
      refusal(
        evidence.caseId,
        `native gateway evidence identifies ${name}, not ${TARGET_AGENT_NAME}`,
      ),
    );
  }
  return Effect.succeed(EvaluationTarget.make({ name }));
}

function socialItem(
  item: SocialEvidence,
  target: EvaluationTarget,
): SocialTranscriptItem | PeerTimeoutTranscriptItem {
  const observation = item.observation;
  if (observation instanceof SocialActionObserved) {
    return SocialTranscriptItem.make({
      evidenceId: item.eventId,
      source: "social",
      direction: observation.direction,
      actorName: agentNameFromAddress(observation.authorAddress),
      endpointName: agentNameFromAddress(observation.endpointAddress),
      address: observation.address,
      parts: observation.content,
    });
  }
  return PeerTimeoutTranscriptItem.make({
    evidenceId: item.eventId,
    source: "peer-timeout",
    direction: "input",
    actorName: target.name,
    endpointName: agentNameFromAddress(observation.endpointAddress),
    parts: textParts(
      `No social action arrived within ${String(observation.timeoutMillis)}ms.`,
      "[No social action observed]",
    ),
  });
}

function agentNameFromAddress(address: typeof AgentAddress.Type): string {
  return address.slice("agent:".length);
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
    const issue = selectedEvidenceIssue(evidence, target);
    if (issue !== undefined) {
      return yield* Effect.fail(refusal(evidence.caseId, issue.detail));
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

/** Project a completed ledger and normalize its selected principal output. */
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
