/** @file Typed evaluation plans, attempts, reports, and state transitions. */

import { CompletedLedgerReceipt, LedgerReceipt } from "@moltzap/simulator";
import { image } from "@moltzap/simulator/agents";
import {
  jsonValue,
  LedgerStorageError,
  type JsonValue,
} from "@moltzap/simulator/ledger";
import { Data, DateTime, Effect, Encoding, Schema } from "effect";
import {
  conditionId,
  criterionId,
  evaluationCaseId,
  evaluationSlice,
  judgePolicyId,
  type ConditionId,
  type EvaluationCaseId,
} from "./model.js";
import {
  CodeAssessment,
  EvaluationTranscript,
  GradeReport,
  judgeError,
  validateAssessmentEvidence,
  type CriterionAssessment,
} from "./grading.js";

const REPORT_FORMAT_VERSION = 3;
const SAMPLE_NUMBER = 1;
const positiveInteger = Schema.Int.pipe(Schema.positive());

/** Filesystem-safe identity for one local evaluation report. */
export const evaluationReportId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]*$/u),
  Schema.brand("EvaluationReportId"),
);
/** Filesystem-safe identity for one local evaluation report. */
export type EvaluationReportId = typeof evaluationReportId.Type;

/** Digest of the immutable execution plan validated during resume. */
export const evaluationPlanDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("EvaluationPlanDigest"),
);

/** Digest of one completed report used as its publication identity. */
export const evaluationReportDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("EvaluationReportDigest"),
);
/** Digest of one completed report used as its publication identity. */
export type EvaluationReportDigest = typeof evaluationReportDigest.Type;

/** Digest binding graded evidence to its attempt identity and ledger receipt. */
const evaluationEvidenceDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("EvaluationEvidenceDigest"),
);
/** Digest binding graded evidence to its attempt identity and ledger receipt. */
type EvaluationEvidenceDigest = typeof evaluationEvidenceDigest.Type;

/** Stable identity of one case-condition sample attempt. */
const evaluationAttemptId = Schema.NonEmptyString.pipe(
  Schema.brand("EvaluationAttemptId"),
);
/** Stable identity of one case-condition sample attempt. */
type EvaluationAttemptId = typeof evaluationAttemptId.Type;

/** Decode a trusted local report identity. */
export const decodeEvaluationReportId = Schema.decodeSync(evaluationReportId);
/** Decode a completed report publication identity. */
export const decodeEvaluationReportDigest = Schema.decodeSync(
  evaluationReportDigest,
);
/** Decode a trusted local matrix-attempt identity. */
export const decodeEvaluationAttemptId = Schema.decodeSync(evaluationAttemptId);

/** Immutable case catalog entry persisted with the report. */
export class EvaluationCasePlan extends Schema.Class<EvaluationCasePlan>(
  "EvaluationCasePlan",
)({
  id: evaluationCaseId,
  definitionId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  rubric: Schema.NonEmptyString,
  criterionIds: Schema.NonEmptyArray(criterionId),
  slices: Schema.NonEmptyArray(evaluationSlice),
}) {}

/** Native, sanitized runtime configuration for one sweep condition. */
export class EvaluationConditionPlan extends Schema.Class<EvaluationConditionPlan>(
  "EvaluationConditionPlan",
)({
  id: conditionId,
  runtimeName: Schema.NonEmptyString,
  runtimeConfiguration: jsonValue,
}) {}

/** Persisted semantic-judge configuration bound into the immutable plan. */
export class JudgePolicySnapshot extends Schema.Class<JudgePolicySnapshot>(
  "JudgePolicySnapshot",
)({
  id: judgePolicyId,
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.Literal("medium"),
  structuredOutput: Schema.Literal(true),
  tools: Schema.Literal("none"),
  timeoutMillis: positiveInteger,
  maxRetries: Schema.Literal(2),
}) {}

/** Non-secret physical environment retained so a resume cannot move a sweep. */
export class LocalEvaluationInfrastructure extends Schema.TaggedClass<LocalEvaluationInfrastructure>()(
  "LocalEvaluationInfrastructure",
  {
    profile: Schema.Literal("local"),
    controllerImage: image,
    peerApplicationImage: image,
    nanoclawApplicationImage: image,
    temporalAddress: Schema.NonEmptyString,
    artifactDirectory: Schema.NonEmptyString,
  },
) {}

/** Non-secret physical environment retained so a resume cannot move a sweep. */
export class GkeEvaluationInfrastructure extends Schema.TaggedClass<GkeEvaluationInfrastructure>()(
  "GkeEvaluationInfrastructure",
  {
    profile: Schema.Literal("gke"),
    controllerImage: image,
    peerApplicationImage: image,
    nanoclawApplicationImage: image,
    temporalAddress: Schema.NonEmptyString,
    kubeContext: Schema.NonEmptyString,
    artifactBucket: Schema.NonEmptyString,
  },
) {}

const evaluationInfrastructure = Schema.Union(
  LocalEvaluationInfrastructure,
  GkeEvaluationInfrastructure,
);

/** Exact non-secret target selected for each submitted evaluation cell. */
export type EvaluationInfrastructure = typeof evaluationInfrastructure.Type;

/** Ordered matrix and all inputs that must match before resume. */
export class EvaluationReportPlan extends Schema.Class<EvaluationReportPlan>(
  "EvaluationReportPlan",
)({
  sourceRevision: Schema.NonEmptyString,
  cases: Schema.NonEmptyArray(EvaluationCasePlan),
  conditions: Schema.NonEmptyArray(EvaluationConditionPlan),
  judgePolicy: JudgePolicySnapshot,
  infrastructure: evaluationInfrastructure,
  samplesPerCell: Schema.Literal(SAMPLE_NUMBER),
}) {}

const evaluationReportPlanValue = Schema.Struct(EvaluationReportPlan.fields);
const evaluationCasePlanValue = Schema.Struct(EvaluationCasePlan.fields);
const evaluationConditionPlanValue = Schema.Struct(
  EvaluationConditionPlan.fields,
);
const judgePolicySnapshotValue = Schema.Struct(JudgePolicySnapshot.fields);

const terminalAttemptFields = {
  attemptId: evaluationAttemptId,
  caseId: evaluationCaseId,
  conditionId,
  sample: Schema.Literal(SAMPLE_NUMBER),
  startedAt: Schema.DateTimeUtc,
  completedAt: Schema.DateTimeUtc,
};

/** Execution and grading both completed with closed behavioral assessments. */
export class AssessedAttempt extends Schema.TaggedClass<AssessedAttempt>()(
  "AssessedAttempt",
  {
    ...terminalAttemptFields,
    receipt: CompletedLedgerReceipt,
    transcript: EvaluationTranscript,
    grade: GradeReport,
    evidenceDigest: evaluationEvidenceDigest,
  },
) {}

/** Simulator execution failed after ledger allocation. */
export class RunFailedAttempt extends Schema.TaggedClass<RunFailedAttempt>()(
  "RunFailedAttempt",
  {
    ...terminalAttemptFields,
    receipt: LedgerReceipt,
    detail: Schema.NonEmptyString,
  },
) {}

/** Completed physical evidence could not be accepted for grading. */
export class EvidenceRejectedAttempt extends Schema.TaggedClass<EvidenceRejectedAttempt>()(
  "EvidenceRejectedAttempt",
  {
    ...terminalAttemptFields,
    receipt: CompletedLedgerReceipt,
    detail: Schema.NonEmptyString,
  },
) {}

/** Code assessments survived, but unresolved semantic grading was unavailable. */
export class JudgingUnavailableAttempt extends Schema.TaggedClass<JudgingUnavailableAttempt>()(
  "JudgingUnavailableAttempt",
  {
    ...terminalAttemptFields,
    receipt: CompletedLedgerReceipt,
    transcript: EvaluationTranscript,
    codeAssessments: Schema.Array(CodeAssessment),
    pendingCriterionIds: Schema.NonEmptyArray(criterionId),
    error: judgeError,
    evidenceDigest: evaluationEvidenceDigest,
  },
) {}

/** Input whose evidence digest is derived by makeAssessedAttempt. */
export type AssessedAttemptInput = Omit<
  AssessedAttempt,
  "_tag" | "evidenceDigest"
>;
/** Input whose evidence digest is derived by makeJudgingUnavailableAttempt. */
export type JudgingUnavailableAttemptInput = Omit<
  JudgingUnavailableAttempt,
  "_tag" | "evidenceDigest"
>;

const assessedEvidenceValue = Schema.Struct({
  kind: Schema.Literal("assessed"),
  ...terminalAttemptFields,
  receipt: CompletedLedgerReceipt,
  transcript: EvaluationTranscript,
  grade: GradeReport,
});

const unavailableJudgingEvidenceValue = Schema.Struct({
  kind: Schema.Literal("judging-unavailable"),
  ...terminalAttemptFields,
  receipt: CompletedLedgerReceipt,
  transcript: EvaluationTranscript,
  codeAssessments: Schema.Array(CodeAssessment),
  pendingCriterionIds: Schema.NonEmptyArray(criterionId),
  error: judgeError,
});

const ledgerStorageErrorValueSchema = Schema.Struct(LedgerStorageError.fields);
const makeLedgerStorageErrorValue =
  Data.tagged<typeof ledgerStorageErrorValueSchema.Type>("LedgerStorageError");

function ledgerStorageErrorValue(
  failure: LedgerStorageError,
): typeof ledgerStorageErrorValueSchema.Type {
  return makeLedgerStorageErrorValue({
    operation: failure.operation,
    detail: failure.detail,
    ref: failure.ref,
    artifact: failure.artifact,
  });
}

const persistedLedgerStorageError = Schema.transform(
  ledgerStorageErrorValueSchema,
  Schema.instanceOf(LedgerStorageError),
  {
    strict: true,
    decode: (failure) =>
      LedgerStorageError.make({
        operation: failure.operation,
        detail: failure.detail,
        ref: failure.ref,
        artifact: failure.artifact,
      }),
    encode: (instance) => ledgerStorageErrorValue(instance),
  },
).annotations({ identifier: "PersistedLedgerStorageError" });

/** Simulator execution could not allocate its durable ledger. */
export class LedgerAllocationFailedAttempt extends Schema.TaggedClass<LedgerAllocationFailedAttempt>()(
  "LedgerAllocationFailedAttempt",
  {
    ...terminalAttemptFields,
    failure: persistedLedgerStorageError,
  },
) {}

/** The complete serialized universe for one terminal matrix cell. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Phoenix encodes the exact closed attempt schema at its publication boundary.
export const terminalAttempt = Schema.Union(
  AssessedAttempt,
  RunFailedAttempt,
  EvidenceRejectedAttempt,
  JudgingUnavailableAttempt,
  LedgerAllocationFailedAttempt,
);
/** Complete terminal state for one matrix cell. */
export type TerminalAttempt = typeof terminalAttempt.Type;

const reportFields = {
  formatVersion: Schema.Literal(REPORT_FORMAT_VERSION),
  reportId: evaluationReportId,
  planDigest: evaluationPlanDigest,
  plan: EvaluationReportPlan,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  attempts: Schema.Array(terminalAttempt),
};

/** Checkpoint state while one or more matrix cells remain missing. */
export class InProgressEvaluationReport extends Schema.TaggedClass<InProgressEvaluationReport>()(
  "InProgressEvaluationReport",
  reportFields,
) {}

/** Exact terminal matrix retained for publication. */
export class CompletedEvaluationReport extends Schema.TaggedClass<CompletedEvaluationReport>()(
  "CompletedEvaluationReport",
  {
    ...reportFields,
    completedAt: Schema.DateTimeUtc,
  },
) {}

const completedEvaluationReportValue = Schema.Struct(
  CompletedEvaluationReport.fields,
);

/** The only two durable report states. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- SQL decoding and publication require the exact closed report schema.
export const evaluationReport = Schema.Union(
  InProgressEvaluationReport,
  CompletedEvaluationReport,
);
/** Durable state of an evaluation report. */
export type EvaluationReport = typeof evaluationReport.Type;

/** One executable cell from the ordered report matrix. */
export interface EvaluationSweepCell {
  readonly attemptId: EvaluationAttemptId;
  readonly casePlan: EvaluationCasePlan;
  readonly conditionPlan: EvaluationConditionPlan;
  readonly sample: typeof SAMPLE_NUMBER;
}

/** Typed report invariant violation. */
export class EvaluationReportValidationError extends Schema.TaggedError<EvaluationReportValidationError>()(
  "EvaluationReportValidationError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

const resumeMismatchField = Schema.Literal(
  "sourceRevision",
  "caseCatalog",
  "judgePolicy",
  "runtimeConfigurations",
  "infrastructure",
  "planDigest",
);
/** Immutable plan component reported by a resume mismatch. */
export type ResumeMismatchField = typeof resumeMismatchField.Type;

/** A resume request does not describe the report's immutable plan. */
export class EvaluationResumeMismatch extends Schema.TaggedError<EvaluationResumeMismatch>()(
  "EvaluationResumeMismatch",
  {
    field: resumeMismatchField,
    expectedDigest: evaluationPlanDigest,
    actualDigest: evaluationPlanDigest,
  },
) {}

/** Completed execution contains one or more operationally failed attempts. */
export class EvaluationSweepIncomplete extends Schema.TaggedError<EvaluationSweepIncomplete>()(
  "EvaluationSweepIncomplete",
  {
    reportId: evaluationReportId,
    attemptIds: Schema.NonEmptyArray(evaluationAttemptId),
  },
) {}

function validationError(detail: string): EvaluationReportValidationError {
  return EvaluationReportValidationError.make({ detail });
}

function describeUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  const detail = String(cause);
  return detail.length > 0 ? detail : "unknown failure";
}

function quote(value: string): string {
  return JSON.stringify(value) ?? '""';
}

function isJsonArray(
  value: readonly JsonValue[] | { readonly [key: string]: JsonValue },
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function compareKeys(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalComposite(
  value: readonly JsonValue[] | { readonly [key: string]: JsonValue },
): string {
  if (isJsonArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const fields = Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => `${quote(key)}:${canonicalJson(entry)}`);
  return `{${fields.join(",")}}`;
}

/**
 * Canonical JSON used for plan, report, and Phoenix reconciliation digests.
 * @param value JSON value to encode.
 * @returns Deterministic JSON text with recursively sorted object keys.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return value === 0 ? "0" : String(value);
  }
  if (typeof value === "string") {
    return quote(value);
  }
  return canonicalComposite(value);
}

function digestSchemaValue<S extends Schema.Schema.AnyNoContext>(
  schema: S,
  value: Schema.Schema.Type<S>,
): Effect.Effect<string, EvaluationReportValidationError> {
  return Schema.encode(schema)(value, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(jsonValue)),
    Effect.map(canonicalJson),
    Effect.flatMap((text) =>
      Effect.tryPromise({
        try: () =>
          globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(text),
          ),
        catch: (cause) =>
          validationError(
            `unable to digest report data: ${describeUnknown(cause)}`,
          ),
      }).pipe(
        Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof EvaluationReportValidationError
        ? cause
        : validationError(`unable to encode report data: ${cause.message}`),
    ),
  );
}

function decodeEvidenceDigest(
  digest: string,
): Effect.Effect<EvaluationEvidenceDigest, EvaluationReportValidationError> {
  return Schema.decodeUnknown(evaluationEvidenceDigest)(digest).pipe(
    Effect.mapError((cause) =>
      validationError(`invalid evidence digest: ${cause.message}`),
    ),
  );
}

function digestAssessedEvidence(
  attempt: AssessedAttemptInput,
): Effect.Effect<EvaluationEvidenceDigest, EvaluationReportValidationError> {
  return digestSchemaValue(assessedEvidenceValue, {
    kind: "assessed",
    attemptId: attempt.attemptId,
    caseId: attempt.caseId,
    conditionId: attempt.conditionId,
    sample: attempt.sample,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    receipt: attempt.receipt,
    transcript: attempt.transcript,
    grade: attempt.grade,
  }).pipe(Effect.flatMap(decodeEvidenceDigest));
}

function digestUnavailableJudgingEvidence(
  attempt: JudgingUnavailableAttemptInput,
): Effect.Effect<EvaluationEvidenceDigest, EvaluationReportValidationError> {
  return digestSchemaValue(unavailableJudgingEvidenceValue, {
    kind: "judging-unavailable",
    attemptId: attempt.attemptId,
    caseId: attempt.caseId,
    conditionId: attempt.conditionId,
    sample: attempt.sample,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    receipt: attempt.receipt,
    transcript: attempt.transcript,
    codeAssessments: attempt.codeAssessments,
    pendingCriterionIds: attempt.pendingCriterionIds,
    error: attempt.error,
  }).pipe(Effect.flatMap(decodeEvidenceDigest));
}

/** Construct a terminal assessed attempt with its complete evidence binding. */
export const makeAssessedAttempt = Effect.fn("evals.makeAssessedAttempt")(
  function* (input: AssessedAttemptInput) {
    const evidenceDigest = yield* digestAssessedEvidence(input);
    return AssessedAttempt.make({ ...input, evidenceDigest });
  },
);

/** Construct an unavailable-judge attempt with its retained evidence bound. */
export const makeJudgingUnavailableAttempt = Effect.fn(
  "evals.makeJudgingUnavailableAttempt",
)(function* (input: JudgingUnavailableAttemptInput) {
  const evidenceDigest = yield* digestUnavailableJudgingEvidence(input);
  return JudgingUnavailableAttempt.make({ ...input, evidenceDigest });
});

/** Compute the digest that binds every immutable resume input. */
const digestEvaluationPlan = Effect.fn("evals.digestEvaluationPlan")(function* (
  plan: EvaluationReportPlan,
) {
  const digest = yield* digestSchemaValue(evaluationReportPlanValue, plan);
  return yield* Schema.decodeUnknown(evaluationPlanDigest)(digest).pipe(
    Effect.mapError((cause) =>
      validationError(`invalid plan digest: ${cause.message}`),
    ),
  );
});

function duplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

/** Validate catalog uniqueness before any report can be created or resumed. */
const validateEvaluationPlan = Effect.fn("evals.validateEvaluationPlan")(
  function* (plan: EvaluationReportPlan) {
    const duplicateCase = duplicate(plan.cases.map((entry) => entry.id));
    if (duplicateCase !== undefined) {
      return yield* Effect.fail(
        validationError(`duplicate evaluation case ${duplicateCase}`),
      );
    }
    const duplicateCondition = duplicate(
      plan.conditions.map((entry) => entry.id),
    );
    if (duplicateCondition !== undefined) {
      return yield* Effect.fail(
        validationError(`duplicate runtime condition ${duplicateCondition}`),
      );
    }
    for (const entry of plan.cases) {
      const duplicateCriterion = duplicate(entry.criterionIds);
      if (duplicateCriterion !== undefined) {
        return yield* Effect.fail(
          validationError(
            `case ${entry.id} contains duplicate criterion ${duplicateCriterion}`,
          ),
        );
      }
    }
    return plan;
  },
);

function rawAttemptId(
  reportId: EvaluationReportId,
  condition: ConditionId,
  evaluationCase: EvaluationCaseId,
): string {
  return `${reportId}/${condition}/${evaluationCase}/${String(SAMPLE_NUMBER).padStart(3, "0")}`;
}

/** Construct the deterministic identity for the matrix's only sample. */
const makeEvaluationAttemptId = Effect.fn("evals.makeEvaluationAttemptId")(
  function* (
    reportId: EvaluationReportId,
    condition: ConditionId,
    evaluationCase: EvaluationCaseId,
  ) {
    return yield* Schema.decodeUnknown(evaluationAttemptId)(
      rawAttemptId(reportId, condition, evaluationCase),
    ).pipe(
      Effect.mapError((cause) =>
        validationError(`invalid attempt identity: ${cause.message}`),
      ),
    );
  },
);

function expectedAttemptIds(report: EvaluationReport): readonly string[] {
  return report.plan.cases.flatMap((casePlan) =>
    report.plan.conditions.map((conditionPlan) =>
      rawAttemptId(report.reportId, conditionPlan.id, casePlan.id),
    ),
  );
}

function gradedCriterionIds(
  attempt: TerminalAttempt,
): readonly string[] | undefined {
  if (attempt instanceof AssessedAttempt) {
    return attempt.grade.assessments.map(
      (assessment) => assessment.criterionId,
    );
  }
  if (attempt instanceof JudgingUnavailableAttempt) {
    return [
      ...attempt.codeAssessments.map((assessment) => assessment.criterionId),
      ...attempt.pendingCriterionIds,
    ];
  }
  return undefined;
}

function attemptTimeIssue(attempt: TerminalAttempt): string | undefined {
  return DateTime.toEpochMillis(attempt.completedAt) <
    DateTime.toEpochMillis(attempt.startedAt)
    ? `attempt ${attempt.attemptId} completes before it starts`
    : undefined;
}

function gradingIdentityIssue(attempt: TerminalAttempt): string | undefined {
  if (
    attempt._tag !== "AssessedAttempt" &&
    attempt._tag !== "JudgingUnavailableAttempt"
  ) {
    return undefined;
  }
  const transcriptMatches = attempt.transcript.caseId === attempt.caseId;
  const gradeMatches =
    attempt._tag !== "AssessedAttempt" ||
    attempt.grade.caseId === attempt.caseId;
  return transcriptMatches && gradeMatches
    ? undefined
    : `attempt ${attempt.attemptId} contains grading data for another case`;
}

function criterionCoverageIssue(
  report: EvaluationReport,
  attempt: TerminalAttempt,
): string | undefined {
  if (
    attempt._tag !== "AssessedAttempt" &&
    attempt._tag !== "JudgingUnavailableAttempt"
  ) {
    return undefined;
  }
  const casePlan = report.plan.cases.find(
    (entry) => entry.id === attempt.caseId,
  );
  const actual = gradedCriterionIds(attempt);
  if (casePlan === undefined || actual === undefined) {
    return `attempt ${attempt.attemptId} has no matching case catalog entry`;
  }
  const expected = casePlan.criterionIds;
  const coversExactly =
    new Set(actual).size === actual.length &&
    actual.length === expected.length &&
    expected.every((criterionId) => actual.includes(criterionId));
  return coversExactly
    ? undefined
    : `attempt ${attempt.attemptId} does not cover the exact criterion set`;
}

function gradedAttemptIssue(
  report: EvaluationReport,
  attempt: TerminalAttempt,
): string | undefined {
  return (
    attemptTimeIssue(attempt) ??
    gradingIdentityIssue(attempt) ??
    criterionCoverageIssue(report, attempt)
  );
}

function validateGradedAttemptEvidence(
  attempt: TerminalAttempt,
): Effect.Effect<void, EvaluationReportValidationError> {
  if (
    !(attempt instanceof AssessedAttempt) &&
    !(attempt instanceof JudgingUnavailableAttempt)
  ) {
    return Effect.void;
  }
  const assessments: readonly CriterionAssessment[] =
    attempt instanceof AssessedAttempt
      ? attempt.grade.assessments
      : attempt.codeAssessments;
  return Effect.gen(function* () {
    yield* validateAssessmentEvidence(attempt.transcript, assessments).pipe(
      Effect.mapError((cause) =>
        validationError(
          `attempt ${attempt.attemptId} has invalid grading evidence: ${cause.detail}`,
        ),
      ),
    );
    if (
      attempt.receipt.completion.recordCount < attempt.transcript.items.length
    ) {
      return yield* Effect.fail(
        validationError(
          `attempt ${attempt.attemptId} transcript exceeds its ledger record count`,
        ),
      );
    }
    const expectedDigest =
      attempt instanceof AssessedAttempt
        ? yield* digestAssessedEvidence(attempt)
        : yield* digestUnavailableJudgingEvidence(attempt);
    if (attempt.evidenceDigest !== expectedDigest) {
      return yield* Effect.fail(
        validationError(
          `attempt ${attempt.attemptId} evidence does not match its ledger receipt`,
        ),
      );
    }
  });
}

function validateAttempt(
  report: EvaluationReport,
  expected: ReadonlySet<string>,
  attempt: TerminalAttempt,
): Effect.Effect<void, EvaluationReportValidationError> {
  return Effect.gen(function* () {
    const expectedId = rawAttemptId(
      report.reportId,
      attempt.conditionId,
      attempt.caseId,
    );
    if (attempt.attemptId !== expectedId || !expected.has(attempt.attemptId)) {
      return yield* Effect.fail(
        validationError(
          `attempt ${attempt.attemptId} does not belong to the report matrix`,
        ),
      );
    }
    const issue = gradedAttemptIssue(report, attempt);
    if (issue !== undefined) {
      return yield* Effect.fail(validationError(issue));
    }
    yield* validateGradedAttemptEvidence(attempt);
  });
}

function attemptOrderIssue(
  report: EvaluationReport,
  expected: readonly string[],
): string | undefined {
  const actual = report.attempts.map((attempt) => attempt.attemptId);
  if (actual.some((attemptId, index) => expected[index] !== attemptId)) {
    return "terminal attempts are not the completed prefix of the matrix";
  }
  if (
    report._tag === "CompletedEvaluationReport" &&
    actual.length !== expected.length
  ) {
    return "completed report does not contain the exact matrix";
  }
  return undefined;
}

function validateAttemptSet(
  report: EvaluationReport,
): Effect.Effect<void, EvaluationReportValidationError> {
  const expected = expectedAttemptIds(report);
  const actual = report.attempts.map((attempt) => attempt.attemptId);
  const duplicateAttempt = duplicate(actual);
  if (duplicateAttempt !== undefined) {
    return Effect.fail(
      validationError(`duplicate terminal attempt ${duplicateAttempt}`),
    );
  }
  const expectedSet = new Set(expected);
  return Effect.forEach(
    report.attempts,
    (attempt) => validateAttempt(report, expectedSet, attempt),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.flatMap(() => {
      const issue = attemptOrderIssue(report, expected);
      return issue === undefined
        ? Effect.void
        : Effect.fail(validationError(issue));
    }),
  );
}

/** Validate a decoded report's digest, matrix identities, and terminal state. */
export const validateEvaluationReport = Effect.fn(
  "evals.validateEvaluationReport",
)(function* (report: EvaluationReport) {
  yield* validateEvaluationPlan(report.plan);
  const digest = yield* digestEvaluationPlan(report.plan);
  if (digest !== report.planDigest) {
    return yield* Effect.fail(
      validationError("report plan digest does not match its immutable plan"),
    );
  }
  yield* validateAttemptSet(report);
  return report;
});

/** Validate the exact completed-report state required by publishers. */
export const validateCompletedEvaluationReport = Effect.fn(
  "evals.validateCompletedEvaluationReport",
)(function* (report: CompletedEvaluationReport) {
  yield* validateEvaluationReport(report);
  return report;
});

/** Compute the publication identity of a validated completed report. */
export const digestEvaluationReport = Effect.fn("evals.digestEvaluationReport")(
  function* (report: CompletedEvaluationReport) {
    const validated = yield* validateCompletedEvaluationReport(report);
    const digest = yield* digestSchemaValue(
      completedEvaluationReportValue,
      validated,
    );
    return yield* Schema.decodeUnknown(evaluationReportDigest)(digest).pipe(
      Effect.mapError((cause) =>
        validationError(`invalid report digest: ${cause.message}`),
      ),
    );
  },
);

/** Create an empty, validated report for an immutable plan. */
export const createEvaluationReport = Effect.fn("evals.createEvaluationReport")(
  function* (reportId: EvaluationReportId, plan: EvaluationReportPlan) {
    yield* validateEvaluationPlan(plan);
    const planDigest = yield* digestEvaluationPlan(plan);
    const now = yield* DateTime.now;
    return InProgressEvaluationReport.make({
      formatVersion: REPORT_FORMAT_VERSION,
      reportId,
      planDigest,
      plan,
      createdAt: now,
      updatedAt: now,
      attempts: [],
    });
  },
);

function matchPlanComponent<S extends Schema.Schema.AnyNoContext>(
  field: ResumeMismatchField,
  schema: S,
  actual: Schema.Schema.Type<S>,
  expected: Schema.Schema.Type<S>,
): Effect.Effect<
  void,
  EvaluationReportValidationError | EvaluationResumeMismatch
> {
  return Effect.all({
    actual: digestSchemaValue(schema, actual).pipe(
      Effect.flatMap(Schema.decodeUnknown(evaluationPlanDigest)),
      Effect.mapError((cause) =>
        cause instanceof EvaluationReportValidationError
          ? cause
          : validationError(`invalid ${field} digest: ${cause.message}`),
      ),
    ),
    expected: digestSchemaValue(schema, expected).pipe(
      Effect.flatMap(Schema.decodeUnknown(evaluationPlanDigest)),
      Effect.mapError((cause) =>
        cause instanceof EvaluationReportValidationError
          ? cause
          : validationError(`invalid ${field} digest: ${cause.message}`),
      ),
    ),
  }).pipe(
    Effect.flatMap((digests) =>
      digests.actual === digests.expected
        ? Effect.void
        : Effect.fail(
            EvaluationResumeMismatch.make({
              field,
              expectedDigest: digests.expected,
              actualDigest: digests.actual,
            }),
          ),
    ),
  );
}

/** Accept a stored report only when every immutable execution input matches. */
export const resumeEvaluationReport = Effect.fn("evals.resumeEvaluationReport")(
  function* (report: EvaluationReport, expectedPlan: EvaluationReportPlan) {
    yield* validateEvaluationPlan(expectedPlan);
    yield* validateEvaluationReport(report);
    yield* matchPlanComponent(
      "sourceRevision",
      Schema.String,
      report.plan.sourceRevision,
      expectedPlan.sourceRevision,
    );
    yield* matchPlanComponent(
      "caseCatalog",
      Schema.Array(evaluationCasePlanValue),
      report.plan.cases,
      expectedPlan.cases,
    );
    yield* matchPlanComponent(
      "judgePolicy",
      judgePolicySnapshotValue,
      report.plan.judgePolicy,
      expectedPlan.judgePolicy,
    );
    yield* matchPlanComponent(
      "runtimeConfigurations",
      Schema.Array(evaluationConditionPlanValue),
      report.plan.conditions,
      expectedPlan.conditions,
    );
    yield* matchPlanComponent(
      "infrastructure",
      evaluationInfrastructure,
      report.plan.infrastructure,
      expectedPlan.infrastructure,
    );
    const expectedDigest = yield* digestEvaluationPlan(expectedPlan);
    if (report.planDigest !== expectedDigest) {
      return yield* Effect.fail(
        EvaluationResumeMismatch.make({
          field: "planDigest",
          expectedDigest,
          actualDigest: report.planDigest,
        }),
      );
    }
    return report;
  },
);

/** Return missing matrix cells in their canonical execution order. */
export const remainingEvaluationCells = Effect.fn(
  "evals.remainingEvaluationCells",
)(function* (report: InProgressEvaluationReport) {
  const cells = yield* Effect.forEach(
    report.plan.cases.flatMap((casePlan) =>
      report.plan.conditions.map((conditionPlan) => ({
        casePlan,
        conditionPlan,
      })),
    ),
    ({ casePlan, conditionPlan }) =>
      makeEvaluationAttemptId(
        report.reportId,
        conditionPlan.id,
        casePlan.id,
      ).pipe(
        Effect.map(
          (attemptId): EvaluationSweepCell => ({
            attemptId,
            casePlan,
            conditionPlan,
            sample: SAMPLE_NUMBER,
          }),
        ),
      ),
    { concurrency: 1 },
  );
  return cells.slice(report.attempts.length);
});

/** Append one immutable terminal attempt to an in-progress report. */
export const appendEvaluationAttempt = Effect.fn(
  "evals.appendEvaluationAttempt",
)(function* (report: InProgressEvaluationReport, attempt: TerminalAttempt) {
  const expected = expectedAttemptIds(report);
  const expectedNext = expected[report.attempts.length];
  if (expectedNext === undefined) {
    return yield* Effect.fail(
      validationError("the report matrix is already terminal"),
    );
  }
  if (attempt.attemptId !== expectedNext) {
    return yield* Effect.fail(
      validationError(
        `attempt ${attempt.attemptId} is not the next matrix cell ${expectedNext}`,
      ),
    );
  }
  const next = InProgressEvaluationReport.make({
    formatVersion: report.formatVersion,
    reportId: report.reportId,
    planDigest: report.planDigest,
    plan: report.plan,
    createdAt: report.createdAt,
    updatedAt: attempt.completedAt,
    attempts: [...report.attempts, attempt],
  });
  yield* validateEvaluationReport(next);
  return next;
});

/** Transition an exact terminal matrix into its publication-only state. */
export const completeEvaluationReport = Effect.fn(
  "evals.completeEvaluationReport",
)(function* (report: InProgressEvaluationReport) {
  const expected = expectedAttemptIds(report);
  if (
    report.attempts.length !== expected.length ||
    expected.some(
      (attemptId, index) => report.attempts[index]?.attemptId !== attemptId,
    )
  ) {
    return yield* Effect.fail(
      validationError("cannot complete a report with missing matrix cells"),
    );
  }
  const completedAt = yield* DateTime.now;
  const completed = CompletedEvaluationReport.make({
    formatVersion: report.formatVersion,
    reportId: report.reportId,
    planDigest: report.planDigest,
    plan: report.plan,
    createdAt: report.createdAt,
    updatedAt: completedAt,
    completedAt,
    attempts: report.attempts,
  });
  return yield* validateCompletedEvaluationReport(completed);
});

/** Fail the CLI only for operational states, never behavioral verdict data. */
export const ensureSweepOperationallyComplete = Effect.fn(
  "evals.ensureSweepOperationallyComplete",
)(function* (report: CompletedEvaluationReport) {
  const failures = report.attempts.filter(
    (attempt) => attempt._tag !== "AssessedAttempt",
  );
  const [firstFailure, ...remainingFailures] = failures;
  if (firstFailure === undefined) {
    return report;
  }
  return yield* Effect.fail(
    EvaluationSweepIncomplete.make({
      reportId: report.reportId,
      attemptIds: [
        firstFailure.attemptId,
        ...remainingFailures.map((attempt) => attempt.attemptId),
      ],
    }),
  );
});
