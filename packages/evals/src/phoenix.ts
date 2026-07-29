/** @file Idempotent Phoenix materialization for completed evaluation reports. */

import {
  createClient,
  HttpError,
  type PhoenixClient,
  type Types,
} from "@arizeai/phoenix-client";
import { createDataset, getDataset } from "@arizeai/phoenix-client/datasets";
import {
  createExperiment,
  getExperimentRuns,
} from "@arizeai/phoenix-client/experiments";
import { getExperimentUrl } from "@arizeai/phoenix-client/utils/urlUtils";
import {
  JsonValue,
  type JsonValue as JsonValueType,
} from "@moltzap/simulator/ledger";
import {
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import type { CodeAssessment, CriterionAssessment } from "./grading.js";
import { ConditionId } from "./cases.js";
import {
  canonicalJson,
  type CompletedEvaluationReport,
  digestEvaluationReport,
  type EvaluationConditionPlan,
  type EvaluationReportPlan,
  EvaluationReportDigest,
  JudgePolicySnapshot,
  type EvaluationReportValidationError,
  type EvidenceRejectedAttempt,
  type JudgingUnavailableAttempt,
  TerminalAttempt,
  type TerminalAttempt as TerminalAttemptType,
  validateCompletedEvaluationReport,
} from "./sweep.js";

const DATASET_NAME = "moltzap-evaluations";
const DATASET_DESCRIPTION =
  "MoltZap code-first behavioral evaluation cases (schema v1).";
const PHOENIX_PUBLICATION_FORMAT_VERSION = 1;
const FIRST_REPETITION = 1;
const PAGE_SIZE = 100;

type PhoenixDataset = Awaited<ReturnType<typeof getDataset>>;
type PhoenixExperiment = Types["V1"]["components"]["schemas"]["Experiment"];
type PhoenixExperimentsPage =
  Types["V1"]["components"]["schemas"]["ListExperimentsResponseBody"];
type PhoenixRun = Awaited<ReturnType<typeof getExperimentRuns>>["runs"][number];

/** Published experiment location for one runtime condition. */
export class PhoenixExperimentPublication extends Schema.Class<PhoenixExperimentPublication>(
  "PhoenixExperimentPublication",
)({
  conditionId: ConditionId,
  experimentId: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
}) {}

/** Immutable publication receipt returned without changing the local report. */
export class PhoenixPublication extends Schema.Class<PhoenixPublication>(
  "PhoenixPublication",
)({
  datasetId: Schema.NonEmptyString,
  reportDigest: EvaluationReportDigest,
  experiments: Schema.NonEmptyArray(PhoenixExperimentPublication),
}) {}

/** Phoenix or its transport rejected one request. */
export class PhoenixRequestFailed extends Schema.TaggedError<PhoenixRequestFailed>()(
  "PhoenixRequestFailed",
  {
    operation: Schema.NonEmptyString,
    detail: Schema.NonEmptyString,
    status: Schema.optional(Schema.Int),
  },
) {}

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

// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- publisher callers consume this closed persisted error vocabulary.
export const PhoenixPublicationError = Schema.Union(
  PhoenixRequestFailed,
  PhoenixPublicationConflict,
  PhoenixPublicationEncodingError,
);
export type PhoenixPublicationError = typeof PhoenixPublicationError.Type;

type PublishFailure = EvaluationReportValidationError | PhoenixPublicationError;

export interface PhoenixPublisherService {
  readonly publish: (
    report: CompletedEvaluationReport,
  ) => Effect.Effect<PhoenixPublication, PublishFailure>;
}

/** Completed-report publication boundary. */
export class PhoenixPublisher extends Context.Tag(
  "@moltzap/evals/PhoenixPublisher",
)<PhoenixPublisher, PhoenixPublisherService>() {}

function describeUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  const detail = String(cause);
  return detail.length > 0 ? detail : "unknown Phoenix failure";
}

function requestFailure(
  operation: string,
  cause: unknown,
): PhoenixRequestFailed {
  return PhoenixRequestFailed.make({
    operation,
    detail: describeUnknown(cause),
    ...(cause instanceof HttpError ? { status: cause.status } : {}),
  });
}

/** The only Promise-to-Effect adaptation used by the publisher. */
/* eslint-disable agent-code-guard/promise-type -- the Phoenix SDK exposes Promise APIs, which enter Effect only through this adapter. */
function phoenixRequest<A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, PhoenixRequestFailed> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => requestFailure(operation, cause),
  });
}
/* eslint-enable agent-code-guard/promise-type -- the Phoenix SDK boundary ends here. */

function encodingError(detail: string): PhoenixPublicationEncodingError {
  return PhoenixPublicationEncodingError.make({ detail });
}

function conflict(
  resource: PhoenixPublicationConflict["resource"],
  identity: string,
  detail: string,
): PhoenixPublicationConflict {
  return PhoenixPublicationConflict.make({ resource, identity, detail });
}

function canonicalUnknown(
  value: unknown,
): Effect.Effect<string, PhoenixPublicationEncodingError> {
  return Schema.decodeUnknown(JsonValue)(value).pipe(
    Effect.map(canonicalJson),
    Effect.mapError((cause) =>
      encodingError(`Phoenix value is not JSON: ${cause.message}`),
    ),
  );
}

function sameJson(
  left: unknown,
  right: unknown,
): Effect.Effect<boolean, PhoenixPublicationEncodingError> {
  return Effect.all({
    left: canonicalUnknown(left),
    right: canonicalUnknown(right),
  }).pipe(Effect.map(({ left, right }) => left === right));
}

function sorted(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/** Canonical Phoenix dataset rows derived from the immutable case catalog. */
export function phoenixCatalogExamples(plan: EvaluationReportPlan) {
  return plan.cases.map((casePlan) => {
    const slices = sorted(casePlan.slices);
    return {
      id: casePlan.id,
      input: {
        caseId: casePlan.id,
        definitionId: casePlan.definitionId,
        name: casePlan.name,
        description: casePlan.description,
        rubric: casePlan.rubric,
        criterionIds: [...casePlan.criterionIds],
      },
      output: {},
      metadata: { slices },
      splits: [...slices],
    };
  });
}

export interface PhoenixDatasetCatalog {
  readonly name: string;
  readonly description?: string | null;
  readonly examples: ReadonlyArray<{
    readonly id: string;
    readonly input: unknown;
    readonly output?: unknown;
    readonly metadata?: unknown;
    readonly splits?: string | ReadonlyArray<string> | null;
  }>;
}

function datasetExampleProjection(
  example: PhoenixDatasetCatalog["examples"][number],
) {
  const splits =
    typeof example.splits === "string"
      ? [example.splits]
      : sorted(example.splits ?? []);
  return {
    id: example.id,
    input: example.input,
    output: example.output ?? {},
    metadata: example.metadata ?? {},
    splits,
  };
}

/**
 * Reconcile remote dataset identity and examples without requiring a live
 * Phoenix client.
 */
export function reconcilePhoenixDatasetCatalog(
  dataset: PhoenixDatasetCatalog,
  plan: EvaluationReportPlan,
): Effect.Effect<
  void,
  PhoenixPublicationConflict | PhoenixPublicationEncodingError
> {
  return Effect.gen(function* () {
    if (dataset.name !== DATASET_NAME) {
      return yield* Effect.fail(
        conflict(
          "dataset",
          DATASET_NAME,
          `remote dataset is named ${dataset.name}`,
        ),
      );
    }
    if (dataset.description !== DATASET_DESCRIPTION) {
      return yield* Effect.fail(
        conflict("dataset", DATASET_NAME, "remote dataset description differs"),
      );
    }
    const actual = dataset.examples
      .map(datasetExampleProjection)
      .sort((left, right) => left.id.localeCompare(right.id));
    const expected = phoenixCatalogExamples(plan).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (!(yield* sameJson(actual, expected))) {
      return yield* Effect.fail(
        conflict(
          "dataset",
          DATASET_NAME,
          "remote examples differ from the report case catalog",
        ),
      );
    }
  }).pipe(Effect.withSpan("evals.reconcilePhoenixDatasetCatalog"));
}

function validateDataset(
  dataset: PhoenixDataset,
  report: CompletedEvaluationReport,
): Effect.Effect<
  PhoenixDataset,
  PhoenixPublicationConflict | PhoenixPublicationEncodingError
> {
  return reconcilePhoenixDatasetCatalog(dataset, report.plan).pipe(
    Effect.as(dataset),
  );
}

function fetchDataset(
  client: PhoenixClient,
): Effect.Effect<PhoenixDataset | undefined, PhoenixRequestFailed> {
  return phoenixRequest("get evaluation dataset", () =>
    getDataset({
      client,
      dataset: { datasetName: DATASET_NAME },
    }),
  ).pipe(
    Effect.catchTag("PhoenixRequestFailed", (error) =>
      error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function updateDatasetCatalog(
  client: PhoenixClient,
  report: CompletedEvaluationReport,
): Effect.Effect<string, PhoenixRequestFailed> {
  const operation = "update evaluation dataset";
  const examples = phoenixCatalogExamples(report.plan);
  return phoenixRequest(operation, () =>
    createDataset({
      client,
      name: DATASET_NAME,
      description: DATASET_DESCRIPTION,
      examples,
    }),
  ).pipe(Effect.map(({ datasetId }) => datasetId));
}

type DatasetFailure =
  | PhoenixRequestFailed
  | PhoenixPublicationConflict
  | PhoenixPublicationEncodingError;

function ensureDataset(
  client: PhoenixClient,
  report: CompletedEvaluationReport,
): Effect.Effect<PhoenixDataset, DatasetFailure> {
  return Effect.gen(function* () {
    yield* updateDatasetCatalog(client, report);
    const current = yield* fetchDataset(client);
    if (current === undefined) {
      return yield* Effect.fail(
        requestFailure(
          "get updated evaluation dataset",
          "dataset disappeared after update",
        ),
      );
    }
    return yield* validateDataset(current, report);
  });
}

function fetchExperimentsPage(
  client: PhoenixClient,
  datasetId: string,
  cursor: string | null,
): Effect.Effect<PhoenixExperimentsPage, PhoenixRequestFailed> {
  const operation = "list evaluation experiments";
  return phoenixRequest(operation, () =>
    client.GET("/v1/datasets/{dataset_id}/experiments", {
      params: {
        path: { dataset_id: datasetId },
        query: { cursor, limit: PAGE_SIZE },
      },
    }),
  ).pipe(
    Effect.flatMap((response) => {
      const page: PhoenixExperimentsPage | undefined = response.data;
      return page === undefined
        ? Effect.fail(
            requestFailure(operation, "Phoenix returned no experiment page"),
          )
        : Effect.succeed(page);
    }),
  );
}

function collectExperimentPage(
  client: PhoenixClient,
  datasetId: string,
  page: PhoenixExperimentsPage,
  collected: ReadonlyArray<PhoenixExperiment>,
): Effect.Effect<ReadonlyArray<PhoenixExperiment>, PhoenixRequestFailed> {
  const next = [...collected, ...page.data];
  if (page.next_cursor === null) return Effect.succeed(next);
  return fetchExperimentsPage(client, datasetId, page.next_cursor).pipe(
    Effect.flatMap((nextPage) =>
      collectExperimentPage(client, datasetId, nextPage, next),
    ),
  );
}

function listExperiments(
  client: PhoenixClient,
  datasetId: string,
): Effect.Effect<ReadonlyArray<PhoenixExperiment>, PhoenixRequestFailed> {
  return fetchExperimentsPage(client, datasetId, null).pipe(
    Effect.flatMap((page) =>
      collectExperimentPage(client, datasetId, page, []),
    ),
  );
}

function experimentName(
  digest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): string {
  return `moltzap/${digest}/${condition.id}`;
}

function experimentDescription(
  report: CompletedEvaluationReport,
  condition: EvaluationConditionPlan,
): string {
  return `MoltZap evaluation report ${report.reportId}, condition ${condition.id}.`;
}

/** Runtime and judge inputs exposed on each condition experiment. */
export function phoenixExperimentProvenance(
  plan: EvaluationReportPlan,
  condition: EvaluationConditionPlan,
): Effect.Effect<
  Record<string, JsonValueType>,
  PhoenixPublicationEncodingError
> {
  return Schema.encode(JudgePolicySnapshot)(plan.judgePolicy, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(JsonValue)),
    Effect.map((judgePolicy) => ({
      runtimeConfiguration: condition.runtimeConfiguration,
      judgePolicy,
    })),
    Effect.mapError((cause) =>
      encodingError(`cannot encode experiment provenance: ${cause.message}`),
    ),
  );
}

function experimentMetadata(
  report: CompletedEvaluationReport,
  digest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): Effect.Effect<
  Record<string, JsonValueType>,
  PhoenixPublicationEncodingError
> {
  return phoenixExperimentProvenance(report.plan, condition).pipe(
    Effect.map((provenance) => ({
      publisher: "@moltzap/evals",
      publicationFormatVersion: PHOENIX_PUBLICATION_FORMAT_VERSION,
      reportId: report.reportId,
      reportDigest: digest,
      planDigest: report.planDigest,
      conditionId: condition.id,
      runtimeName: condition.runtimeName,
      sourceRevision: report.plan.sourceRevision,
      ...provenance,
    })),
  );
}

interface PublicationContext {
  readonly client: PhoenixClient;
  readonly dataset: PhoenixDataset;
  readonly report: CompletedEvaluationReport;
  readonly digest: EvaluationReportDigest;
}

function experimentMatches(
  experiment: PhoenixExperiment,
  context: PublicationContext,
  condition: EvaluationConditionPlan,
): Effect.Effect<boolean, PhoenixPublicationEncodingError> {
  const identity = experimentName(context.digest, condition);
  return Effect.gen(function* () {
    const expectedMetadata = yield* experimentMetadata(
      context.report,
      context.digest,
      condition,
    );
    const metadataMatches = yield* sameJson(
      experiment.metadata,
      expectedMetadata,
    );
    return [
      experiment.name === identity,
      experiment.description ===
        experimentDescription(context.report, condition),
      experiment.dataset_id === context.dataset.id,
      experiment.dataset_version_id === context.dataset.versionId,
      experiment.repetitions === FIRST_REPETITION,
      metadataMatches,
    ].every(Boolean);
  });
}

function validateExperiment(
  experiment: PhoenixExperiment,
  context: PublicationContext,
  condition: EvaluationConditionPlan,
): Effect.Effect<
  PhoenixExperiment,
  PhoenixPublicationConflict | PhoenixPublicationEncodingError
> {
  const identity = experimentName(context.digest, condition);
  return Effect.gen(function* () {
    if (!(yield* experimentMatches(experiment, context, condition))) {
      return yield* Effect.fail(
        conflict(
          "experiment",
          identity,
          "remote experiment identity or metadata differs",
        ),
      );
    }
    return experiment;
  });
}

function fetchExperiment(
  client: PhoenixClient,
  experimentId: string,
): Effect.Effect<PhoenixExperiment, PhoenixRequestFailed> {
  const operation = "get evaluation experiment";
  return phoenixRequest(operation, () =>
    client.GET("/v1/experiments/{experiment_id}", {
      params: { path: { experiment_id: experimentId } },
    }),
  ).pipe(
    Effect.flatMap((response) => {
      const experiment = response.data?.data;
      return experiment === undefined
        ? Effect.fail(
            requestFailure(operation, "Phoenix returned no experiment"),
          )
        : Effect.succeed(experiment);
    }),
  );
}

function ensureExperiment(
  context: PublicationContext,
  condition: EvaluationConditionPlan,
): Effect.Effect<PhoenixExperiment, DatasetFailure> {
  return Effect.gen(function* () {
    const identity = experimentName(context.digest, condition);
    const experiments = yield* listExperiments(
      context.client,
      context.dataset.id,
    );
    const matches = experiments.filter(
      (experiment) => experiment.name === identity,
    );
    const [existing, ...duplicates] = matches;
    if (duplicates.length > 0) {
      return yield* Effect.fail(
        conflict("experiment", identity, "remote identity is not unique"),
      );
    }
    if (existing !== undefined) {
      return yield* validateExperiment(existing, context, condition);
    }
    const metadata = yield* experimentMetadata(
      context.report,
      context.digest,
      condition,
    );
    const created = yield* phoenixRequest("create evaluation experiment", () =>
      createExperiment({
        client: context.client,
        datasetId: context.dataset.id,
        datasetVersionId: context.dataset.versionId,
        experimentName: identity,
        experimentDescription: experimentDescription(context.report, condition),
        experimentMetadata: metadata,
        repetitions: FIRST_REPETITION,
      }),
    );
    const remote = yield* fetchExperiment(context.client, created.id);
    return yield* validateExperiment(remote, context, condition);
  });
}

function encodeAttempt(
  attempt: TerminalAttemptType,
): Effect.Effect<JsonValueType, PhoenixPublicationEncodingError> {
  return Schema.encode(TerminalAttempt)(attempt, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(JsonValue)),
    Effect.mapError((cause) =>
      encodingError(
        `cannot encode attempt ${attempt.attemptId}: ${cause.message}`,
      ),
    ),
  );
}

function runError(attempt: TerminalAttemptType): string | null {
  switch (attempt._tag) {
    case "RunFailedAttempt":
      return `${attempt._tag}: ${attempt.detail}`;
    case "LedgerAllocationFailedAttempt":
      return `${attempt._tag}: ${attempt.failure.detail}`;
    case "AssessedAttempt":
    case "EvidenceRejectedAttempt":
    case "JudgingUnavailableAttempt":
      return null;
  }
}

interface ExpectedRun {
  readonly datasetExampleId: string;
  readonly output: JsonValueType;
  readonly error: string | null;
  readonly startTime: string;
  readonly endTime: string;
}

function expectedRun(
  attempt: TerminalAttemptType,
  datasetExampleId: string,
): Effect.Effect<ExpectedRun, PhoenixPublicationEncodingError> {
  return encodeAttempt(attempt).pipe(
    Effect.map((output) => ({
      datasetExampleId,
      output,
      error: runError(attempt),
      startTime: DateTime.formatIso(attempt.startedAt),
      endTime: DateTime.formatIso(attempt.completedAt),
    })),
  );
}

function validateRun(
  remote: PhoenixRun,
  expected: ExpectedRun,
  attemptId: string,
): Effect.Effect<
  PhoenixRun,
  PhoenixPublicationConflict | PhoenixPublicationEncodingError
> {
  return Effect.gen(function* () {
    const outputMatches = yield* sameJson(remote.output, expected.output);
    const matches = [
      remote.datasetExampleId === expected.datasetExampleId,
      remote.error === expected.error,
      remote.startTime.toISOString() === expected.startTime,
      remote.endTime.toISOString() === expected.endTime,
      outputMatches,
    ].every(Boolean);
    if (!matches) {
      return yield* Effect.fail(
        conflict("run", attemptId, "remote experiment run differs"),
      );
    }
    return remote;
  });
}

function createRun(
  client: PhoenixClient,
  experimentId: string,
  expected: ExpectedRun,
): Effect.Effect<string, PhoenixRequestFailed> {
  const operation = "create evaluation experiment run";
  return phoenixRequest(operation, () =>
    client.POST("/v1/experiments/{experiment_id}/runs", {
      params: { path: { experiment_id: experimentId } },
      body: {
        dataset_example_id: expected.datasetExampleId,
        output: expected.output,
        repetition_number: FIRST_REPETITION,
        start_time: expected.startTime,
        end_time: expected.endTime,
        error: expected.error,
      },
    }),
  ).pipe(
    Effect.flatMap((response) => {
      const run = response.data?.data;
      return run === undefined
        ? Effect.fail(
            requestFailure(
              operation,
              "Phoenix returned no experiment-run identity",
            ),
          )
        : Effect.succeed(run.id);
    }),
  );
}

function fetchRuns(
  client: PhoenixClient,
  experimentId: string,
): Effect.Effect<ReadonlyArray<PhoenixRun>, PhoenixRequestFailed> {
  return phoenixRequest("get evaluation experiment runs", () =>
    getExperimentRuns({ client, experimentId, pageSize: PAGE_SIZE }),
  ).pipe(Effect.map(({ runs }) => runs));
}

function uniqueRunByExample(
  runs: ReadonlyArray<PhoenixRun>,
  datasetExampleId: string,
  attemptId: string,
): Effect.Effect<PhoenixRun | undefined, PhoenixPublicationConflict> {
  const matching = runs.filter(
    (run) => run.datasetExampleId === datasetExampleId,
  );
  const [run, ...duplicates] = matching;
  return duplicates.length > 0
    ? Effect.fail(
        conflict("run", attemptId, "remote run identity is not unique"),
      )
    : Effect.succeed(run);
}

interface RunContext {
  readonly client: PhoenixClient;
  readonly experimentId: string;
  readonly runs: ReadonlyArray<PhoenixRun>;
}

function recoverConcurrentRun(
  context: RunContext,
  expected: ExpectedRun,
  attemptId: string,
  creationError: PhoenixRequestFailed,
): Effect.Effect<string, DatasetFailure> {
  return Effect.gen(function* () {
    const refreshed = yield* fetchRuns(context.client, context.experimentId);
    const raced = yield* uniqueRunByExample(
      refreshed,
      expected.datasetExampleId,
      attemptId,
    );
    if (raced === undefined) return yield* Effect.fail(creationError);
    const validated = yield* validateRun(raced, expected, attemptId);
    return validated.id;
  });
}

function createOrRecoverRun(
  context: RunContext,
  expected: ExpectedRun,
  attemptId: string,
): Effect.Effect<string, DatasetFailure> {
  return createRun(context.client, context.experimentId, expected).pipe(
    Effect.catchTag("PhoenixRequestFailed", (error) =>
      error.status === 409
        ? recoverConcurrentRun(context, expected, attemptId, error)
        : Effect.fail(error),
    ),
  );
}

function ensureRun(
  context: RunContext,
  attempt: TerminalAttemptType,
  datasetExampleId: string,
): Effect.Effect<string, DatasetFailure> {
  return Effect.gen(function* () {
    const expected = yield* expectedRun(attempt, datasetExampleId);
    const existing = yield* uniqueRunByExample(
      context.runs,
      datasetExampleId,
      attempt.attemptId,
    );
    if (existing !== undefined) {
      const validated = yield* validateRun(
        existing,
        expected,
        attempt.attemptId,
      );
      return validated.id;
    }
    return yield* createOrRecoverRun(context, expected, attempt.attemptId);
  });
}

function score(verdict: CriterionAssessment["verdict"]): number | null {
  switch (verdict) {
    case "passed":
      return 1;
    case "failed":
      return 0;
    case "undecided":
      return null;
  }
}

interface ExpectedEvaluation {
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

function codeEvaluations(
  assessments: ReadonlyArray<CodeAssessment>,
  reportDigest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): ReadonlyArray<ExpectedEvaluation> {
  return assessments.map((assessment) =>
    assessmentEvaluation(assessment, reportDigest, condition),
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
): ReadonlyArray<ExpectedEvaluation> {
  const error = `${attempt.error._tag}: ${attempt.error.detail}`;
  const failures: ReadonlyArray<ExpectedEvaluation> =
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
    ...codeEvaluations(attempt.codeAssessments, reportDigest, condition),
    ...failures,
  ];
}

/** Pure Phoenix assessment rows for one terminal local attempt. */
export function phoenixAttemptEvaluations(
  attempt: TerminalAttemptType,
  reportDigest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): ReadonlyArray<ExpectedEvaluation> {
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
  }
}

function upsertEvaluation(
  client: PhoenixClient,
  runId: string,
  attempt: TerminalAttemptType,
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

function datasetExampleId(
  dataset: PhoenixDataset,
  caseId: string,
): Effect.Effect<string, PhoenixPublicationConflict> {
  const examples = dataset.examples.filter((example) => example.id === caseId);
  const [example, ...duplicates] = examples;
  if (example === undefined || duplicates.length > 0) {
    return Effect.fail(
      conflict(
        "dataset",
        DATASET_NAME,
        `case ${caseId} does not have exactly one stable example`,
      ),
    );
  }
  return Effect.succeed(example.nodeId);
}

interface ConditionPublicationContext {
  readonly publication: PublicationContext;
  readonly condition: EvaluationConditionPlan;
  readonly experimentId: string;
  readonly remoteRuns: ReadonlyArray<PhoenixRun>;
}

function publishAttemptEvaluations(
  context: ConditionPublicationContext,
  runId: string,
  attempt: TerminalAttemptType,
): Effect.Effect<void, PhoenixRequestFailed> {
  const { client } = context.publication;
  const evaluations = phoenixAttemptEvaluations(
    attempt,
    context.publication.digest,
    context.condition,
  );
  return Effect.forEach(
    evaluations,
    (evaluation) => upsertEvaluation(client, runId, attempt, evaluation),
    { concurrency: 1, discard: true },
  );
}

function publishAttempt(
  context: ConditionPublicationContext,
  attempt: TerminalAttemptType,
): Effect.Effect<void, PhoenixPublicationError> {
  return Effect.gen(function* () {
    const { client, dataset } = context.publication;
    const exampleId = yield* datasetExampleId(dataset, attempt.caseId);
    const runId = yield* ensureRun(
      {
        client,
        experimentId: context.experimentId,
        runs: context.remoteRuns,
      },
      attempt,
      exampleId,
    );
    yield* publishAttemptEvaluations(context, runId, attempt);
  });
}

function experimentUrl(
  baseUrl: string,
  datasetId: string,
  experimentId: string,
): Effect.Effect<string, PhoenixPublicationEncodingError> {
  return Effect.try({
    try: () => getExperimentUrl({ baseUrl, datasetId, experimentId }),
    catch: (cause) =>
      encodingError(
        `cannot construct Phoenix experiment URL: ${describeUnknown(cause)}`,
      ),
  });
}

function publishCondition(
  publication: PublicationContext,
  baseUrl: string,
  condition: EvaluationConditionPlan,
): Effect.Effect<PhoenixExperimentPublication, PhoenixPublicationError> {
  return Effect.gen(function* () {
    const experiment = yield* ensureExperiment(publication, condition);
    const remoteRuns = yield* fetchRuns(publication.client, experiment.id);
    const context: ConditionPublicationContext = {
      publication,
      condition,
      experimentId: experiment.id,
      remoteRuns,
    };
    const attempts = publication.report.attempts.filter(
      (attempt) => attempt.conditionId === condition.id,
    );
    yield* Effect.forEach(
      attempts,
      (attempt) => publishAttempt(context, attempt),
      { concurrency: 1, discard: true },
    );
    const url = yield* experimentUrl(
      baseUrl,
      publication.dataset.id,
      experiment.id,
    );
    return PhoenixExperimentPublication.make({
      conditionId: condition.id,
      experimentId: experiment.id,
      url,
    });
  });
}

/** Build a publisher around an explicitly configured Phoenix client. */
export function makePhoenixPublisher(
  client: PhoenixClient,
  baseUrl: string,
): PhoenixPublisherService {
  return {
    publish: (report) =>
      Effect.gen(function* () {
        const validated = yield* validateCompletedEvaluationReport(report);
        const digest = yield* digestEvaluationReport(validated);
        const dataset = yield* ensureDataset(client, validated);
        const publication: PublicationContext = {
          client,
          dataset,
          report: validated,
          digest,
        };
        const [firstCondition, ...remainingConditions] =
          validated.plan.conditions;
        const first = yield* publishCondition(
          publication,
          baseUrl,
          firstCondition,
        );
        const remaining = yield* Effect.forEach(
          remainingConditions,
          (condition) => publishCondition(publication, baseUrl, condition),
          { concurrency: 1 },
        );
        return PhoenixPublication.make({
          datasetId: dataset.id,
          reportDigest: digest,
          experiments: [first, ...remaining],
        });
      }).pipe(Effect.withSpan("evals.publishPhoenixReport")),
  };
}

const PhoenixHost = Config.string("PHOENIX_HOST");
const PhoenixApiKey = Config.option(Config.redacted("PHOENIX_API_KEY"));

/** Externally managed Phoenix connection configured only through Effect. */
export const PhoenixPublisherLive = Layer.effect(
  PhoenixPublisher,
  Effect.gen(function* () {
    const baseUrl = yield* PhoenixHost;
    const apiKey = yield* PhoenixApiKey;
    const headers = Option.match(apiKey, {
      onNone: () => undefined,
      onSome: (key) => ({
        Authorization: `Bearer ${Redacted.value(key)}`,
      }),
    });
    const client = createClient({
      options: {
        baseUrl,
        ...(headers === undefined ? {} : { headers }),
      },
      getEnvironmentOptions: () => ({}),
    });
    return makePhoenixPublisher(client, baseUrl);
  }).pipe(Effect.withSpan("PhoenixPublisherLive")),
);
