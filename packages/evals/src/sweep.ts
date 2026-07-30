/** @file Durable evaluation reports and sequential matrix execution. */
/* eslint-disable max-lines -- the locked report owner keeps its schemas, relational validation, atomic persistence, and sequential state transitions together. */

import { FileSystem, Path } from "@effect/platform";
import { CompletedLedgerReceipt, LedgerReceipt } from "@moltzap/simulator";
import {
  JsonValue,
  LedgerStorageError,
  type JsonValue as JsonValueType,
} from "@moltzap/simulator/ledger";
import { Data, DateTime, Effect, Encoding, Schema } from "effect";
import {
  ConditionId,
  CriterionId,
  EvaluationCaseId,
  EvaluationSlice,
  JudgePolicyId,
} from "./cases.js";
import { RuntimeTerminationEvidenceReadOutcome } from "./events.js";
import {
  CodeAssessment,
  CriterionAssessment,
  EvaluationTranscript,
  GradeReport,
  JudgeError,
  validateAssessmentEvidence,
} from "./grading.js";

const REPORT_FORMAT_VERSION = 2;
const SAMPLE_NUMBER = 1;
const JSON_INDENT_SPACES = 2;
const REPORT_FILE_MODE = 0o600;
const PositiveInteger = Schema.Int.pipe(Schema.positive());

/** Filesystem-safe identity for one local evaluation report. */
export const EvaluationReportId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]*$/iu),
  Schema.brand("EvaluationReportId"),
);
export type EvaluationReportId = typeof EvaluationReportId.Type;

/** Digest of the immutable execution plan validated during resume. */
const EvaluationPlanDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("EvaluationPlanDigest"),
);
type EvaluationPlanDigest = typeof EvaluationPlanDigest.Type;

/** Digest of one completed report used as its publication identity. */
export const EvaluationReportDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("EvaluationReportDigest"),
);
export type EvaluationReportDigest = typeof EvaluationReportDigest.Type;

/** Digest binding graded evidence to its attempt identity and ledger receipt. */
export const EvaluationEvidenceDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("EvaluationEvidenceDigest"),
);
export type EvaluationEvidenceDigest = typeof EvaluationEvidenceDigest.Type;

/** Stable identity of one case-condition sample attempt. */
export const EvaluationAttemptId = Schema.NonEmptyString.pipe(
  Schema.brand("EvaluationAttemptId"),
);
export type EvaluationAttemptId = typeof EvaluationAttemptId.Type;

/** Immutable case catalog entry persisted with the report. */
export class EvaluationCasePlan extends Schema.Class<EvaluationCasePlan>(
  "EvaluationCasePlan",
)({
  id: EvaluationCaseId,
  definitionId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  rubric: Schema.NonEmptyString,
  criterionIds: Schema.NonEmptyArray(CriterionId),
  slices: Schema.NonEmptyArray(EvaluationSlice),
}) {}

/** Native, sanitized runtime configuration for one sweep condition. */
export class EvaluationConditionPlan extends Schema.Class<EvaluationConditionPlan>(
  "EvaluationConditionPlan",
)({
  id: ConditionId,
  runtimeName: Schema.NonEmptyString,
  runtimeConfiguration: JsonValue,
}) {}

/** Persisted semantic-judge configuration bound into the immutable plan. */
export class JudgePolicySnapshot extends Schema.Class<JudgePolicySnapshot>(
  "JudgePolicySnapshot",
)({
  id: JudgePolicyId,
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  reasoningEffort: Schema.Literal("medium"),
  structuredOutput: Schema.Literal(true),
  tools: Schema.Literal("none"),
  timeoutMillis: PositiveInteger,
  maxRetries: Schema.Literal(2),
}) {}

/** Ordered matrix and all inputs that must match before resume. */
export class EvaluationReportPlan extends Schema.Class<EvaluationReportPlan>(
  "EvaluationReportPlan",
)({
  sourceRevision: Schema.NonEmptyString,
  cases: Schema.NonEmptyArray(EvaluationCasePlan),
  conditions: Schema.NonEmptyArray(EvaluationConditionPlan),
  judgePolicy: JudgePolicySnapshot,
  samplesPerCell: Schema.Literal(SAMPLE_NUMBER),
}) {}

const EvaluationReportPlanValue = Schema.Struct(EvaluationReportPlan.fields);
const EvaluationCasePlanValue = Schema.Struct(EvaluationCasePlan.fields);
const EvaluationConditionPlanValue = Schema.Struct(
  EvaluationConditionPlan.fields,
);
const JudgePolicySnapshotValue = Schema.Struct(JudgePolicySnapshot.fields);

const TerminalAttemptFields = {
  attemptId: EvaluationAttemptId,
  caseId: EvaluationCaseId,
  conditionId: ConditionId,
  sample: Schema.Literal(SAMPLE_NUMBER),
  startedAt: Schema.DateTimeUtc,
  completedAt: Schema.DateTimeUtc,
};

/** Execution and grading both completed with closed behavioral assessments. */
export class AssessedAttempt extends Schema.TaggedClass<AssessedAttempt>()(
  "AssessedAttempt",
  {
    ...TerminalAttemptFields,
    receipt: CompletedLedgerReceipt,
    transcript: EvaluationTranscript,
    grade: GradeReport,
    evidenceDigest: EvaluationEvidenceDigest,
  },
) {}

/** Simulator execution failed after ledger allocation. */
export class RunFailedAttempt extends Schema.TaggedClass<RunFailedAttempt>()(
  "RunFailedAttempt",
  {
    ...TerminalAttemptFields,
    receipt: LedgerReceipt,
    detail: Schema.NonEmptyString,
    runtimeEvidence: RuntimeTerminationEvidenceReadOutcome,
  },
) {}

/** Completed physical evidence could not be accepted for grading. */
export class EvidenceRejectedAttempt extends Schema.TaggedClass<EvidenceRejectedAttempt>()(
  "EvidenceRejectedAttempt",
  {
    ...TerminalAttemptFields,
    receipt: CompletedLedgerReceipt,
    detail: Schema.NonEmptyString,
  },
) {}

/** Code assessments survived, but unresolved semantic grading was unavailable. */
export class JudgingUnavailableAttempt extends Schema.TaggedClass<JudgingUnavailableAttempt>()(
  "JudgingUnavailableAttempt",
  {
    ...TerminalAttemptFields,
    receipt: CompletedLedgerReceipt,
    transcript: EvaluationTranscript,
    codeAssessments: Schema.Array(CodeAssessment),
    pendingCriterionIds: Schema.NonEmptyArray(CriterionId),
    error: JudgeError,
    evidenceDigest: EvaluationEvidenceDigest,
  },
) {}

export type AssessedAttemptInput = Omit<
  AssessedAttempt,
  "_tag" | "evidenceDigest"
>;
export type JudgingUnavailableAttemptInput = Omit<
  JudgingUnavailableAttempt,
  "_tag" | "evidenceDigest"
>;

const AssessedEvidenceValue = Schema.Struct({
  kind: Schema.Literal("assessed"),
  ...TerminalAttemptFields,
  receipt: CompletedLedgerReceipt,
  transcript: EvaluationTranscript,
  grade: GradeReport,
});

const UnavailableJudgingEvidenceValue = Schema.Struct({
  kind: Schema.Literal("judging-unavailable"),
  ...TerminalAttemptFields,
  receipt: CompletedLedgerReceipt,
  transcript: EvaluationTranscript,
  codeAssessments: Schema.Array(CodeAssessment),
  pendingCriterionIds: Schema.NonEmptyArray(CriterionId),
  error: JudgeError,
});

const LedgerStorageErrorValue = Schema.Struct(LedgerStorageError.fields);
const makeLedgerStorageErrorValue =
  Data.tagged<typeof LedgerStorageErrorValue.Type>("LedgerStorageError");

function ledgerStorageErrorValue(
  failure: LedgerStorageError,
): typeof LedgerStorageErrorValue.Type {
  return makeLedgerStorageErrorValue({
    operation: failure.operation,
    detail: failure.detail,
    ref: failure.ref,
    artifact: failure.artifact,
  });
}

const PersistedLedgerStorageError = Schema.transform(
  LedgerStorageErrorValue,
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
    encode: (_failure, instance) => ledgerStorageErrorValue(instance),
  },
).annotations({ identifier: "PersistedLedgerStorageError" });

/** Simulator execution could not allocate its durable ledger. */
export class LedgerAllocationFailedAttempt extends Schema.TaggedClass<LedgerAllocationFailedAttempt>()(
  "LedgerAllocationFailedAttempt",
  {
    ...TerminalAttemptFields,
    failure: PersistedLedgerStorageError,
  },
) {}

/** The complete serialized universe for one terminal matrix cell. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Phoenix encodes the exact closed attempt schema at its publication boundary.
export const TerminalAttempt = Schema.Union(
  AssessedAttempt,
  RunFailedAttempt,
  EvidenceRejectedAttempt,
  JudgingUnavailableAttempt,
  LedgerAllocationFailedAttempt,
);
export type TerminalAttempt = typeof TerminalAttempt.Type;

const ReportFields = {
  formatVersion: Schema.Literal(REPORT_FORMAT_VERSION),
  reportId: EvaluationReportId,
  planDigest: EvaluationPlanDigest,
  plan: EvaluationReportPlan,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  attempts: Schema.Array(TerminalAttempt),
};

/** Checkpoint state while one or more matrix cells remain missing. */
export class InProgressEvaluationReport extends Schema.TaggedClass<InProgressEvaluationReport>()(
  "InProgressEvaluationReport",
  ReportFields,
) {}

/** Exact terminal matrix retained for publication. */
export class CompletedEvaluationReport extends Schema.TaggedClass<CompletedEvaluationReport>()(
  "CompletedEvaluationReport",
  {
    ...ReportFields,
    completedAt: Schema.DateTimeUtc,
  },
) {}

const CompletedEvaluationReportValue = Schema.Struct(
  CompletedEvaluationReport.fields,
);

/** The only two durable report states. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- checkpoint decoding requires the exact closed report schema.
export const EvaluationReport = Schema.Union(
  InProgressEvaluationReport,
  CompletedEvaluationReport,
);
export type EvaluationReport = typeof EvaluationReport.Type;

const EvaluationReportText = Schema.parseJson(EvaluationReport, {
  space: JSON_INDENT_SPACES,
});

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

/** Report filesystem read or decode failure. */
class EvaluationReportReadError extends Schema.TaggedError<EvaluationReportReadError>()(
  "EvaluationReportReadError",
  {
    path: Schema.NonEmptyString,
    detail: Schema.NonEmptyString,
  },
) {}

/** Atomic report encoding or checkpoint failure. */
export class EvaluationReportWriteError extends Schema.TaggedError<EvaluationReportWriteError>()(
  "EvaluationReportWriteError",
  {
    path: Schema.NonEmptyString,
    detail: Schema.NonEmptyString,
  },
) {}

const ResumeMismatchField = Schema.Literal(
  "sourceRevision",
  "caseCatalog",
  "judgePolicy",
  "runtimeConfigurations",
  "planDigest",
);
export type ResumeMismatchField = typeof ResumeMismatchField.Type;

/** A resume request does not describe the report's immutable plan. */
export class EvaluationResumeMismatch extends Schema.TaggedError<EvaluationResumeMismatch>()(
  "EvaluationResumeMismatch",
  {
    field: ResumeMismatchField,
    expectedDigest: EvaluationPlanDigest,
    actualDigest: EvaluationPlanDigest,
  },
) {}

/** Completed execution contains one or more operationally failed attempts. */
export class EvaluationSweepIncomplete extends Schema.TaggedError<EvaluationSweepIncomplete>()(
  "EvaluationSweepIncomplete",
  {
    reportId: EvaluationReportId,
    attemptIds: Schema.NonEmptyArray(EvaluationAttemptId),
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
  value:
    | ReadonlyArray<JsonValueType>
    | { readonly [key: string]: JsonValueType },
): value is ReadonlyArray<JsonValueType> {
  return Array.isArray(value);
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalComposite(
  value:
    | ReadonlyArray<JsonValueType>
    | { readonly [key: string]: JsonValueType },
): string {
  if (isJsonArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const fields = Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => `${quote(key)}:${canonicalJson(entry)}`);
  return `{${fields.join(",")}}`;
}

/** Canonical JSON used for plan, report, and Phoenix reconciliation digests. */
export function canonicalJson(value: JsonValueType): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return value === 0 ? "0" : String(value);
    case "string":
      return quote(value);
    case "object":
      return canonicalComposite(value);
  }
}

function digestSchemaValue<S extends Schema.Schema.AnyNoContext>(
  schema: S,
  value: Schema.Schema.Type<S>,
): Effect.Effect<string, EvaluationReportValidationError> {
  return Schema.encode(schema)(value, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(JsonValue)),
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
  return Schema.decodeUnknown(EvaluationEvidenceDigest)(digest).pipe(
    Effect.mapError((cause) =>
      validationError(`invalid evidence digest: ${cause.message}`),
    ),
  );
}

function digestAssessedEvidence(
  attempt: AssessedAttemptInput,
): Effect.Effect<EvaluationEvidenceDigest, EvaluationReportValidationError> {
  return digestSchemaValue(AssessedEvidenceValue, {
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
  return digestSchemaValue(UnavailableJudgingEvidenceValue, {
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
  const digest = yield* digestSchemaValue(EvaluationReportPlanValue, plan);
  return yield* Schema.decodeUnknown(EvaluationPlanDigest)(digest).pipe(
    Effect.mapError((cause) =>
      validationError(`invalid plan digest: ${cause.message}`),
    ),
  );
});

/** Compute the publication identity of a validated completed report. */
export const digestEvaluationReport = Effect.fn("evals.digestEvaluationReport")(
  function* (report: CompletedEvaluationReport) {
    const validated = yield* validateCompletedEvaluationReport(report);
    const digest = yield* digestSchemaValue(
      CompletedEvaluationReportValue,
      validated,
    );
    return yield* Schema.decodeUnknown(EvaluationReportDigest)(digest).pipe(
      Effect.mapError((cause) =>
        validationError(`invalid report digest: ${cause.message}`),
      ),
    );
  },
);

function duplicate(values: ReadonlyArray<string>): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
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
  conditionId: typeof ConditionId.Type,
  caseId: typeof EvaluationCaseId.Type,
): string {
  return `${reportId}/${conditionId}/${caseId}/${String(SAMPLE_NUMBER).padStart(3, "0")}`;
}

/** Construct the deterministic identity for the matrix's only sample. */
export const makeEvaluationAttemptId = Effect.fn(
  "evals.makeEvaluationAttemptId",
)(function* (
  reportId: EvaluationReportId,
  conditionId: typeof ConditionId.Type,
  caseId: typeof EvaluationCaseId.Type,
) {
  return yield* Schema.decodeUnknown(EvaluationAttemptId)(
    rawAttemptId(reportId, conditionId, caseId),
  ).pipe(
    Effect.mapError((cause) =>
      validationError(`invalid attempt identity: ${cause.message}`),
    ),
  );
});

function expectedAttemptIds(report: EvaluationReport): ReadonlyArray<string> {
  return report.plan.cases.flatMap((casePlan) =>
    report.plan.conditions.map((conditionPlan) =>
      rawAttemptId(report.reportId, conditionPlan.id, casePlan.id),
    ),
  );
}

function gradedCriterionIds(
  attempt: TerminalAttempt,
): ReadonlyArray<string> | undefined {
  switch (attempt._tag) {
    case "AssessedAttempt":
      return attempt.grade.assessments.map(
        (assessment) => assessment.criterionId,
      );
    case "JudgingUnavailableAttempt":
      return [
        ...attempt.codeAssessments.map((assessment) => assessment.criterionId),
        ...attempt.pendingCriterionIds,
      ];
    case "RunFailedAttempt":
    case "EvidenceRejectedAttempt":
    case "LedgerAllocationFailedAttempt":
      return undefined;
  }
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
  const assessments: ReadonlyArray<CriterionAssessment> =
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
    const transcriptMessageCount = attempt.transcript.conversations.reduce(
      (count, conversation) => count + conversation.messages.length,
      0,
    );
    if (attempt.receipt.completion.recordCount < transcriptMessageCount) {
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
  expected: ReadonlyArray<string>,
): string | undefined {
  const actual = report.attempts.map((attempt) => attempt.attemptId);
  const actualSet = new Set<string>(actual);
  const relativeOrder = expected.filter((attemptId) =>
    actualSet.has(attemptId),
  );
  if (relativeOrder.some((attemptId, index) => actual[index] !== attemptId)) {
    return "terminal attempts are not in matrix order";
  }
  const completeMatrix =
    actual.length === expected.length &&
    expected.every((attemptId, index) => actual[index] === attemptId);
  if (report._tag === "CompletedEvaluationReport" && !completeMatrix) {
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

/** Create an empty, validated report checkpoint for an immutable plan. */
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

/** Resolve the default local handoff path without exposing it as storage identity. */
export const evaluationReportPath = Effect.fn("evals.evaluationReportPath")(
  function* (reportId: EvaluationReportId) {
    const path = yield* Path.Path;
    return path.join(".moltzap", "evals", "reports", `${reportId}.json`);
  },
);

function writeError(path: string, cause: unknown): EvaluationReportWriteError {
  return EvaluationReportWriteError.make({
    path,
    detail: describeUnknown(cause),
  });
}

/** Encode, sync, and atomically rename one report checkpoint in-place. */
export const checkpointEvaluationReport = Effect.fn(
  "evals.checkpointEvaluationReport",
)(function* (reportPath: string, report: EvaluationReport) {
  const validated = yield* validateEvaluationReport(report).pipe(
    Effect.mapError((cause) => writeError(reportPath, cause)),
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(reportPath);
  const text = yield* Schema.encode(EvaluationReportText, {
    onExcessProperty: "error",
  })(validated).pipe(Effect.mapError((cause) => writeError(reportPath, cause)));
  yield* fileSystem
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError((cause) => writeError(reportPath, cause)));
  const temporary = yield* fileSystem
    .makeTempFile({
      directory,
      prefix: `.${path.basename(reportPath)}.`,
      suffix: ".tmp",
    })
    .pipe(Effect.mapError((cause) => writeError(reportPath, cause)));
  const publish = Effect.gen(function* () {
    yield* fileSystem.writeFileString(temporary, `${text}\n`, {
      mode: REPORT_FILE_MODE,
    });
    yield* Effect.scoped(
      fileSystem
        .open(temporary, { flag: "r" })
        .pipe(Effect.flatMap((file) => file.sync)),
    );
    yield* fileSystem.rename(temporary, reportPath);
  }).pipe(
    Effect.withSpan("evals.checkpointEvaluationReport.publish"),
    Effect.mapError((cause) => writeError(reportPath, cause)),
    Effect.ensuring(
      fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
    ),
  );
  yield* publish;
  return validated;
});

/** Decode and validate one report before it can be resumed or published. */
export const loadEvaluationReport = Effect.fn("evals.loadEvaluationReport")(
  function* (reportPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(reportPath).pipe(
      Effect.mapError((cause) =>
        EvaluationReportReadError.make({
          path: reportPath,
          detail: describeUnknown(cause),
        }),
      ),
    );
    if (!exists) {
      return yield* Effect.fail(
        EvaluationReportReadError.make({
          path: reportPath,
          detail: "report does not exist",
        }),
      );
    }
    const text = yield* fileSystem.readFileString(reportPath).pipe(
      Effect.mapError((cause) =>
        EvaluationReportReadError.make({
          path: reportPath,
          detail: describeUnknown(cause),
        }),
      ),
    );
    const decoded = yield* Schema.decodeUnknown(EvaluationReportText)(text, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) =>
        EvaluationReportReadError.make({
          path: reportPath,
          detail: cause.message,
        }),
      ),
    );
    return yield* validateEvaluationReport(decoded);
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
      Effect.flatMap(Schema.decodeUnknown(EvaluationPlanDigest)),
      Effect.mapError((cause) =>
        cause instanceof EvaluationReportValidationError
          ? cause
          : validationError(`invalid ${field} digest: ${cause.message}`),
      ),
    ),
    expected: digestSchemaValue(schema, expected).pipe(
      Effect.flatMap(Schema.decodeUnknown(EvaluationPlanDigest)),
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

/** Load a report only when every immutable execution input still matches. */
export const resumeEvaluationReport = Effect.fn("evals.resumeEvaluationReport")(
  function* (reportPath: string, expectedPlan: EvaluationReportPlan) {
    yield* validateEvaluationPlan(expectedPlan);
    const report = yield* loadEvaluationReport(reportPath);
    yield* matchPlanComponent(
      "sourceRevision",
      Schema.String,
      report.plan.sourceRevision,
      expectedPlan.sourceRevision,
    );
    yield* matchPlanComponent(
      "caseCatalog",
      Schema.Array(EvaluationCasePlanValue),
      report.plan.cases,
      expectedPlan.cases,
    );
    yield* matchPlanComponent(
      "judgePolicy",
      JudgePolicySnapshotValue,
      report.plan.judgePolicy,
      expectedPlan.judgePolicy,
    );
    yield* matchPlanComponent(
      "runtimeConfigurations",
      Schema.Array(EvaluationConditionPlanValue),
      report.plan.conditions,
      expectedPlan.conditions,
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

function attemptIndex(
  report: EvaluationReport,
): ReadonlyMap<string, TerminalAttempt> {
  return new Map(
    report.attempts.map((attempt) => [attempt.attemptId, attempt]),
  );
}

function matrixCells(
  report: InProgressEvaluationReport,
): Effect.Effect<
  ReadonlyArray<EvaluationSweepCell>,
  EvaluationReportValidationError
> {
  const attempts = attemptIndex(report);
  return Effect.forEach(
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
  ).pipe(
    Effect.map((cells) =>
      cells.filter((cell) => !attempts.has(cell.attemptId)),
    ),
  );
}

function appendAttempt(
  report: InProgressEvaluationReport,
  attempt: TerminalAttempt,
): Effect.Effect<InProgressEvaluationReport, EvaluationReportValidationError> {
  return Effect.gen(function* () {
    if (
      report.attempts.some(
        (existing) => existing.attemptId === attempt.attemptId,
      )
    ) {
      return yield* Effect.fail(
        validationError(`attempt ${attempt.attemptId} is already terminal`),
      );
    }
    const expected = expectedAttemptIds(report);
    const nextAttempts = [...report.attempts, attempt].sort(
      (left, right) =>
        expected.indexOf(left.attemptId) - expected.indexOf(right.attemptId),
    );
    const next = InProgressEvaluationReport.make({
      formatVersion: report.formatVersion,
      reportId: report.reportId,
      planDigest: report.planDigest,
      plan: report.plan,
      createdAt: report.createdAt,
      updatedAt: attempt.completedAt,
      attempts: nextAttempts,
    });
    yield* validateEvaluationReport(next);
    return next;
  });
}

function executeAndCheckpoint<E, R>(
  reportPath: string,
  report: InProgressEvaluationReport,
  cell: EvaluationSweepCell,
  execute: (cell: EvaluationSweepCell) => Effect.Effect<TerminalAttempt, E, R>,
): Effect.Effect<
  InProgressEvaluationReport,
  E | EvaluationReportValidationError | EvaluationReportWriteError,
  FileSystem.FileSystem | Path.Path | R
> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const attempt = yield* restore(execute(cell));
      const next = yield* appendAttempt(report, attempt);
      yield* checkpointEvaluationReport(reportPath, next);
      return next;
    }),
  );
}

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

/**
 * Execute every missing cell sequentially and checkpoint after each terminal
 * attempt. A completed input is returned without retrying any terminal cell.
 */
export const runEvaluationSweep = <E, R>(
  reportPath: string,
  report: EvaluationReport,
  execute: (cell: EvaluationSweepCell) => Effect.Effect<TerminalAttempt, E, R>,
): Effect.Effect<
  CompletedEvaluationReport,
  E | EvaluationReportValidationError | EvaluationReportWriteError,
  FileSystem.FileSystem | Path.Path | R
> => {
  if (report._tag === "CompletedEvaluationReport") {
    return validateCompletedEvaluationReport(report);
  }
  return Effect.gen(function* () {
    const cells = yield* matrixCells(report);
    const terminal = yield* Effect.reduce(cells, report, (current, cell) =>
      executeAndCheckpoint(reportPath, current, cell, execute),
    );
    const completed = yield* completeEvaluationReport(terminal);
    yield* checkpointEvaluationReport(reportPath, completed);
    return completed;
  }).pipe(Effect.withSpan("evals.runEvaluationSweep"));
};

/** Fail the CLI only for operational states, never behavioral verdict data. */
export const ensureSweepOperationallyComplete = Effect.fn(
  "evals.ensureSweepOperationallyComplete",
)(function* (report: CompletedEvaluationReport) {
  const failures = report.attempts.filter(
    (attempt) => attempt._tag !== "AssessedAttempt",
  );
  const [firstFailure, ...remainingFailures] = failures;
  if (firstFailure === undefined) return report;
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
