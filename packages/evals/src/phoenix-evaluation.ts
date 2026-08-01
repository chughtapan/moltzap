/** @file Per-criterion assessment rows materialized on each Phoenix experiment run. */

import type { PhoenixClient } from "@arizeai/phoenix-client";
import type { JsonValue as JsonValueType } from "@moltzap/simulator/ledger";
import { DateTime, Effect } from "effect";
import type { CriterionAssessment } from "./grading.js";
import { type PhoenixRequestFailed, phoenixRequest } from "./phoenix-client.js";
import type {
  EvaluationConditionPlan,
  EvaluationReportDigest,
  EvidenceRejectedAttempt,
  JudgingUnavailableAttempt,
  TerminalAttempt,
} from "./sweep.js";

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

/**
 * Pure Phoenix assessment rows for one terminal local attempt.
 * @param attempt Validated terminal matrix attempt.
 * @param reportDigest Stable local report digest.
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
 * Write one assessment row, replacing any row Phoenix already holds under its name.
 * @param client Configured Phoenix SDK client.
 * @param runId Experiment run the row annotates.
 * @param attempt Attempt whose start and end times the row inherits.
 * @param evaluation Row to materialize.
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
