/** @file Criterion assessment provenance and one-semantic-call case grading. */

import { Array as Arr, Effect, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type {
  CriterionDefinition,
  CriterionEvidence,
  EvaluationCaseMetadata,
} from "./cases.js";
import {
  JudgeBundle,
  JudgeCriterion,
  type JudgeResult,
  SemanticJudge,
  evidenceNotice,
  judgeError,
  validateJudgeResult,
} from "./judge.js";
import {
  CriterionDecided,
  type CriterionVerdict,
  type EvaluationCaseId,
  type JudgePolicyId,
  NeedsJudge,
  criterionId,
  criterionVerdict,
  evaluationCaseId,
  evaluationEvidenceId,
} from "./model.js";
import {
  type EvaluationTranscript,
  type GradingRefused,
  PeerTimeoutTranscriptItem,
  citationIssue,
  refusal,
  validateEvaluationTranscript,
} from "./transcript.js";

/** Conclusive deterministic provenance for one criterion. */
export class CodeAssessment extends Schema.TaggedClass<CodeAssessment>()(
  "CodeAssessment",
  {
    criterionId: criterionId,
    verdict: Schema.Literal("passed", "failed"),
    detail: Schema.NonEmptyString,
    citations: Schema.NonEmptyArray(evaluationEvidenceId),
  },
) {}

/** Auditable model provenance for one semantic criterion. */
export class SemanticAssessment extends Schema.TaggedClass<SemanticAssessment>()(
  "SemanticAssessment",
  {
    criterionId: criterionId,
    verdict: criterionVerdict,
    rationale: Schema.NonEmptyString,
    citations: Schema.NonEmptyArray(evaluationEvidenceId),
  },
) {}

/** Closed assessment universe persisted in reports and Phoenix. */
const criterionAssessment = Schema.Union(CodeAssessment, SemanticAssessment);
/** Deterministic or semantic provenance for one criterion. */
export type CriterionAssessment = typeof criterionAssessment.Type;

/** Validate persisted assessment citations against normalized evidence. */
export const validateAssessmentEvidence = Effect.fn(
  "evals.validateAssessmentEvidence",
)(function* (
  transcript: EvaluationTranscript,
  assessments: readonly CriterionAssessment[],
) {
  yield* validateEvaluationTranscript(transcript);
  for (const assessment of assessments) {
    const issue = citationIssue(
      transcript,
      assessment.criterionId,
      assessment.citations,
    );
    if (issue !== undefined) {
      return yield* Effect.fail(refusal(transcript.caseId, issue.detail));
    }
  }
  return assessments;
});

const verdictPrecedence = {
  passed: 0,
  undecided: 1,
  failed: 2,
} as const satisfies Readonly<Record<CriterionVerdict, number>>;

/**
 * Reduce nonempty assessments using failed-over-undecided-over-passed precedence.
 * @param assessments Criterion assessments for one case.
 * @returns The report-level verdict.
 */
export function verdictOf(
  assessments: NonEmptyReadonlyArray<CriterionAssessment>,
): CriterionVerdict {
  return assessments.reduce<CriterionVerdict>(
    (current, assessment) =>
      verdictPrecedence[assessment.verdict] > verdictPrecedence[current]
        ? assessment.verdict
        : current,
    "passed",
  );
}

/** A report persists assessments and derives its verdict from that evidence. */
export class GradeReport extends Schema.Class<GradeReport>("GradeReport")({
  caseId: evaluationCaseId,
  assessments: Schema.NonEmptyArray(criterionAssessment),
}) {
  get verdict(): CriterionVerdict {
    return verdictOf(this.assessments);
  }
}

/** A case completed deterministic and semantic grading. */
export class GradeCompleted extends Schema.TaggedClass<GradeCompleted>()(
  "GradeCompleted",
  { report: GradeReport },
) {}

/** Judge failure retains every conclusive deterministic assessment. */
export class GradeJudgeFailed extends Schema.TaggedClass<GradeJudgeFailed>()(
  "GradeJudgeFailed",
  {
    caseId: evaluationCaseId,
    codeAssessments: Schema.Array(CodeAssessment),
    pendingCriterionIds: Schema.NonEmptyArray(criterionId),
    error: judgeError,
  },
) {}

function selectedEvidence(
  transcript: EvaluationTranscript,
): Effect.Effect<CriterionEvidence, GradingRefused> {
  return Effect.gen(function* () {
    yield* validateEvaluationTranscript(transcript);
    const selected = transcript.selectedEvidenceIds.flatMap((evidenceId) => {
      const item = transcript.items.find(
        (candidate) => candidate.evidenceId === evidenceId,
      );
      return item === undefined
        ? []
        : [
            {
              evidenceId,
              source: item.source,
              parts:
                item instanceof PeerTimeoutTranscriptItem ? [] : item.parts,
            },
          ];
    });
    const [first, ...remaining] = selected;
    if (
      first === undefined ||
      selected.length !== transcript.selectedEvidenceIds.length
    ) {
      return yield* Effect.fail(
        refusal(
          transcript.caseId,
          "every selected observation must resolve exactly once",
        ),
      );
    }
    return { selected: [first, ...remaining] };
  });
}

const criterionDecision = Schema.Union(CriterionDecided, NeedsJudge);

/** One case criterion paired with the decision its code policy produced. */
export interface CriterionResolution {
  readonly definition: CriterionDefinition;
  readonly decision: CriterionDecided | NeedsJudge;
}

const decideCriterion = Effect.fn("evals.decideCriterion")(function* (
  transcript: EvaluationTranscript,
  evidence: CriterionEvidence,
  definitionEntry: CriterionDefinition,
) {
  const candidate = yield* Effect.try({
    try: () => definitionEntry.decide(evidence),
    catch: (cause) =>
      refusal(
        transcript.caseId,
        `criterion ${definitionEntry.criterion.id} failed: ${String(cause)}`,
      ),
  });
  const decision = yield* Schema.decodeUnknown(criterionDecision)(
    candidate,
  ).pipe(
    Effect.mapError((cause) =>
      refusal(
        transcript.caseId,
        `criterion ${definitionEntry.criterion.id} returned an invalid decision: ${cause.message}`,
      ),
    ),
  );
  if (decision.criterionId !== definitionEntry.criterion.id) {
    return yield* Effect.fail(
      refusal(
        transcript.caseId,
        `criterion ${definitionEntry.criterion.id} returned decision ${decision.criterionId}`,
      ),
    );
  }
  if (decision instanceof CriterionDecided) {
    const issue = citationIssue(
      transcript,
      decision.criterionId,
      decision.citations,
    );
    if (issue !== undefined) {
      return yield* Effect.fail(refusal(transcript.caseId, issue.detail));
    }
  }
  return {
    definition: definitionEntry,
    decision,
  } satisfies CriterionResolution;
});

/** Run every code criterion sequentially so evidence access stays ordered. */
export const decideCriteria = Effect.fn("evals.decideCriteria")(function* (
  definition: EvaluationCaseMetadata,
  transcript: EvaluationTranscript,
) {
  const evidence = yield* selectedEvidence(transcript);
  const [firstDefinition, ...remainingDefinitions] = definition.criteria;
  const first = yield* decideCriterion(transcript, evidence, firstDefinition);
  const remaining = yield* Effect.forEach(
    remainingDefinitions,
    (definitionEntry) => decideCriterion(transcript, evidence, definitionEntry),
    { concurrency: 1 },
  );
  return [
    first,
    ...remaining,
  ] satisfies NonEmptyReadonlyArray<CriterionResolution>;
});

interface CodeOnlyCriteria {
  readonly _tag: "CodeOnlyCriteria";
  readonly code: NonEmptyReadonlyArray<CodeAssessment>;
}

interface JudgeCriteria {
  readonly _tag: "JudgeCriteria";
  readonly code: readonly CodeAssessment[];
  readonly pending: NonEmptyReadonlyArray<JudgeCriterion>;
}

type PartitionedCriteria = CodeOnlyCriteria | JudgeCriteria;

function codeAssessment(decision: CriterionDecided): CodeAssessment {
  return CodeAssessment.make({
    criterionId: decision.criterionId,
    verdict: decision.verdict,
    detail: decision.detail,
    citations: decision.citations,
  });
}

/**
 * Restate an unresolved criterion as the question the semantic judge answers.
 * @param resolution A criterion whose code policy deferred to the judge.
 * @returns The judge-facing criterion carried in the bundle and the calibration
 * corpus alike, so both request the same shape.
 */
export function pendingCriterion(
  resolution: CriterionResolution & { readonly decision: NeedsJudge },
): JudgeCriterion {
  return JudgeCriterion.make({
    id: resolution.definition.criterion.id,
    name: resolution.definition.criterion.name,
    question: resolution.decision.question,
  });
}

function partitionCriteria(
  resolutions: NonEmptyReadonlyArray<CriterionResolution>,
): PartitionedCriteria {
  const [firstResolution, ...remainingResolutions] = resolutions;
  const code: CodeAssessment[] = [];
  const pending: JudgeCriterion[] = [];
  for (const resolution of remainingResolutions) {
    if (resolution.decision instanceof CriterionDecided) {
      code.push(codeAssessment(resolution.decision));
    } else {
      pending.push(
        pendingCriterion({
          definition: resolution.definition,
          decision: resolution.decision,
        }),
      );
    }
  }
  const [firstPending, ...remainingPending] = pending;
  if (firstResolution.decision instanceof CriterionDecided) {
    const firstCode = codeAssessment(firstResolution.decision);
    if (firstPending === undefined) {
      return {
        _tag: "CodeOnlyCriteria",
        code: [firstCode, ...code],
      };
    }
    return {
      _tag: "JudgeCriteria",
      code: [firstCode, ...code],
      pending: [firstPending, ...remainingPending],
    };
  }
  return {
    _tag: "JudgeCriteria",
    code,
    pending: [
      pendingCriterion({
        definition: firstResolution.definition,
        decision: firstResolution.decision,
      }),
      ...pending,
    ],
  };
}

function gradePendingCriteria(
  definition: EvaluationCaseMetadata,
  transcript: EvaluationTranscript,
  policyId: JudgePolicyId,
  criteria: JudgeCriteria,
): Effect.Effect<GradeCompleted | GradeJudgeFailed, never, SemanticJudge> {
  return Effect.gen(function* () {
    const bundle = JudgeBundle.make({
      policyId,
      caseId: definition.id,
      rubric: definition.rubric,
      evidenceNotice,
      criteria: criteria.pending,
      transcript,
    });
    const judge = yield* SemanticJudge;
    return yield* judge.assess(bundle).pipe(
      Effect.flatMap((result) => validateJudgeResult(bundle, result)),
      Effect.match({
        onFailure: (error) =>
          GradeJudgeFailed.make({
            caseId: definition.id,
            codeAssessments: criteria.code,
            pendingCriterionIds: Arr.map(
              criteria.pending,
              (criterion) => criterion.id,
            ),
            error,
          }),
        onSuccess: (result) =>
          completedGrade(definition.id, criteria.code, result),
      }),
    );
  });
}

function completedGrade(
  caseId: EvaluationCaseId,
  code: readonly CodeAssessment[],
  judged: JudgeResult,
): GradeCompleted {
  const semantic = Arr.map(judged.criteria, (result) =>
    SemanticAssessment.make({
      criterionId: result.criterionId,
      verdict: result.verdict,
      rationale: result.rationale,
      citations: result.citations,
    }),
  );
  const [firstCode, ...remainingCode] = code;
  const [firstSemantic, ...remainingSemantic] = semantic;
  const assessments: NonEmptyReadonlyArray<CriterionAssessment> =
    firstCode === undefined
      ? [firstSemantic, ...remainingSemantic]
      : [firstCode, ...remainingCode, ...semantic];
  return GradeCompleted.make({
    report: GradeReport.make({
      caseId,
      assessments,
    }),
  });
}

/** Grade all criteria, making at most one semantic call for the case. */
export const gradeTranscript = Effect.fn("evals.gradeTranscript")(function* (
  definition: EvaluationCaseMetadata,
  transcript: EvaluationTranscript,
  policyId: JudgePolicyId,
) {
  if (definition.id !== transcript.caseId) {
    return yield* Effect.fail(
      refusal(
        transcript.caseId,
        `case definition ${definition.id} does not match transcript ${transcript.caseId}`,
      ),
    );
  }
  const criteria = partitionCriteria(
    yield* decideCriteria(definition, transcript),
  );
  if (criteria._tag === "CodeOnlyCriteria") {
    return GradeCompleted.make({
      report: GradeReport.make({
        caseId: definition.id,
        assessments: criteria.code,
      }),
    });
  }

  return yield* gradePendingCriteria(
    definition,
    transcript,
    policyId,
    criteria,
  );
});
