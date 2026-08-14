/** @file Publication failure vocabulary and the canonical JSON comparison it relies on. */

import type { PhoenixClient } from "@arizeai/phoenix-client";
import {
  jsonValue,
  type JsonValue as JsonValueType,
} from "@moltzap/simulator/ledger";
import { DateTime, Effect, Schema } from "effect";
import type { CriterionAssessment } from "./assessment.js";
import {
  type PhoenixDataset,
  phoenixRequest,
  type PhoenixRequestFailed,
} from "./phoenix-client.js";
import {
  canonicalJson,
  type CompletedEvaluationReport,
  type EvaluationConditionPlan,
  type EvaluationReportDigest,
  type EvidenceRejectedAttempt,
  type JudgingUnavailableAttempt,
  type TerminalAttempt,
} from "./sweep.js";

/** Publication format the remote experiment metadata declares. */
export const PHOENIX_PUBLICATION_FORMAT_VERSION = 1;
/** Every attempt publishes as the first and only repetition. */
export const FIRST_REPETITION = 1;

/** A stable publication identity already names different remote state. */
export class PhoenixPublicationConflict extends Schema.TaggedError<PhoenixPublicationConflict>()(
  "PhoenixPublicationConflict",
  {
    resource: Schema.Literal("dataset", "experiment", "run"),
    identity: Schema.NonEmptyString,
    detail: Schema.NonEmptyString,
  },
) {}

/** Validated local data could not be represented by the Phoenix API. */
export class PhoenixPublicationEncodingError extends Schema.TaggedError<PhoenixPublicationEncodingError>()(
  "PhoenixPublicationEncodingError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** Closed set of failures that stop publication without changing the report. */
export type PhoenixPublicationError =
  | PhoenixRequestFailed
  | PhoenixPublicationConflict
  | PhoenixPublicationEncodingError;

/** Failures reachable while reconciling datasets, experiments, and runs. */
export type DatasetFailure =
  | PhoenixRequestFailed
  | PhoenixPublicationConflict
  | PhoenixPublicationEncodingError;

/** Remote and local state shared by every step of one report publication. */
export interface PublicationContext {
  readonly client: PhoenixClient;
  readonly dataset: PhoenixDataset;
  readonly report: CompletedEvaluationReport;
  readonly digest: EvaluationReportDigest;
}

/** One Phoenix annotation row derived from local assessment provenance. */
export interface ExpectedEvaluation {
  readonly name: string;
  readonly annotatorKind: "CODE" | "LLM";
  readonly result: {
    readonly label: string;
    readonly score: number | null;
    readonly explanation: string;
  } | null;
  readonly error: string | null;
  readonly metadata: Record<string, JsonValueType>;
}

/**
 * Report data that Phoenix cannot represent.
 * @param detail What could not be encoded.
 * @returns A failure that stops publication before any remote write.
 */
export function encodingError(detail: string): PhoenixPublicationEncodingError {
  return PhoenixPublicationEncodingError.make({ detail });
}

/**
 * Report remote state that contradicts a stable publication identity.
 * @param resource Which Phoenix resource disagrees.
 * @param identity The stable identity under which the disagreement was found.
 * @param detail What differs between local and remote state.
 * @returns A failure that leaves the remote resource untouched.
 */
export function conflict(
  resource: PhoenixPublicationConflict["resource"],
  identity: string,
  detail: string,
): PhoenixPublicationConflict {
  return PhoenixPublicationConflict.make({ resource, identity, detail });
}

/**
 * Compare two values by canonical JSON so key order never causes a false conflict.
 * @param left One value, typically the remote projection.
 * @param right The other value, typically the expected local projection.
 * @returns True when both encode to identical canonical JSON.
 */
export function sameJson(
  left: unknown,
  right: unknown,
): Effect.Effect<boolean, PhoenixPublicationEncodingError> {
  return Effect.all({
    left: canonicalUnknown(left),
    right: canonicalUnknown(right),
  }).pipe(Effect.map(({ left, right }) => left === right));
}

/**
 * Derive Phoenix assessment rows from one terminal local attempt.
 * @param attempt Validated terminal matrix attempt.
 * @param reportDigest Stable digest of the authoritative local report.
 * @param condition Runtime condition for the attempt.
 * @returns Assessment rows to materialize on the experiment run.
 */
export function phoenixAttemptEvaluations(
  attempt: TerminalAttempt,
  reportDigest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): readonly ExpectedEvaluation[] {
  switch (attempt._tag) {
    case "AssessedAttempt":
      return attempt.grade.assessments.map((assessment) =>
        assessmentEvaluation(assessment, reportDigest, condition),
      );
    case "EvidenceRejectedAttempt":
      return [evidenceErrorEvaluation(attempt, reportDigest, condition)];
    case "JudgingUnavailableAttempt":
      return judgeErrorEvaluations(attempt, reportDigest, condition);
    case "RunFailedAttempt":
    case "LedgerAllocationFailedAttempt":
      return [];
    default:
      return attempt;
  }
}

/**
 * Replace the named assessment row on a Phoenix experiment run.
 * @param client Configured Phoenix SDK client.
 * @param runId Experiment run the row annotates.
 * @param attempt Attempt whose start and end times the row inherits.
 * @param evaluation Assessment row to materialize.
 * @returns Completion once Phoenix accepts the row.
 */
export function upsertEvaluation(
  client: PhoenixClient,
  runId: string,
  attempt: TerminalAttempt,
  evaluation: ExpectedEvaluation,
): Effect.Effect<void, PhoenixRequestFailed> {
  return phoenixRequest("upsert evaluation assessment", () =>
    client.POST("/v1/experiment_evaluations", {
      body: {
        experiment_run_id: runId,
        name: evaluation.name,
        annotator_kind: evaluation.annotatorKind,
        start_time: DateTime.formatIso(attempt.startedAt),
        end_time: DateTime.formatIso(attempt.completedAt),
        result: evaluation.result,
        error: evaluation.error,
        metadata: evaluation.metadata,
      },
    }),
  ).pipe(Effect.asVoid);
}

function canonicalUnknown(
  value: unknown,
): Effect.Effect<string, PhoenixPublicationEncodingError> {
  return Schema.decodeUnknown(jsonValue)(value).pipe(
    Effect.map(canonicalJson),
    Effect.mapError((cause) =>
      encodingError(`Phoenix value is not JSON: ${cause.message}`),
    ),
  );
}

function evidenceErrorEvaluation(
  attempt: EvidenceRejectedAttempt,
  reportDigest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): ExpectedEvaluation {
  return {
    name: "moltzap.evidence",
    annotatorKind: "CODE",
    result: null,
    error: attempt.detail,
    metadata: {
      source: "code",
      reportDigest,
      conditionId: condition.id,
    },
  };
}

function judgeErrorEvaluations(
  attempt: JudgingUnavailableAttempt,
  reportDigest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): readonly ExpectedEvaluation[] {
  const error = `${attempt.error._tag}: ${attempt.error.detail}`;
  const failures: readonly ExpectedEvaluation[] =
    attempt.pendingCriterionIds.map(
      (criterionId): ExpectedEvaluation => ({
        name: criterionId,
        annotatorKind: "LLM",
        result: null,
        error,
        metadata: {
          source: "model",
          criterionId,
          reportDigest,
          conditionId: condition.id,
        },
      }),
    );
  return [
    ...attempt.codeAssessments.map((assessment) =>
      assessmentEvaluation(assessment, reportDigest, condition),
    ),
    ...failures,
  ];
}

function assessmentEvaluation(
  assessment: CriterionAssessment,
  reportDigest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): ExpectedEvaluation {
  return {
    name: assessment.criterionId,
    annotatorKind: assessment._tag === "CodeAssessment" ? "CODE" : "LLM",
    result: {
      label: assessment.verdict,
      score: score(assessment.verdict),
      explanation:
        assessment._tag === "CodeAssessment"
          ? assessment.detail
          : assessment.rationale,
    },
    error: null,
    metadata: {
      source: assessment._tag === "CodeAssessment" ? "code" : "model",
      criterionId: assessment.criterionId,
      citations: [...assessment.citations],
      reportDigest,
      conditionId: condition.id,
    },
  };
}

function score(verdict: CriterionAssessment["verdict"]): number | null {
  switch (verdict) {
    case "passed":
      return 1;
    case "failed":
      return 0;
    case "undecided":
      return null;
    default:
      return verdict;
  }
}
