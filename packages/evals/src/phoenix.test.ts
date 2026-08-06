import { assert, describe, it } from "@effect/vitest";
import {
  createClient,
  type PhoenixClient,
  type Types,
} from "@arizeai/phoenix-client";
import { CompletedLedgerReceipt } from "@moltzap/simulator";
import { image } from "@moltzap/simulator/agents";
import {
  LedgerCompletion,
  LedgerStorageError,
  ledgerDigest,
  ledgerRef,
} from "@moltzap/simulator/ledger";
import { DateTime, Effect, Option, Ref, Schema } from "effect";
import {
  decodeConditionId,
  decodeCriterionId,
  decodeEvaluationCaseId,
  decodeJudgePolicyId,
} from "./model.js";
import {
  PhoenixPublicationConflict,
  findPhoenixDataset,
  makePhoenixPublisher,
  phoenixCatalogExamples,
  phoenixAttemptEvaluations,
  phoenixExperimentProvenance,
  phoenixPublishedDatasetVersion,
  reconcilePhoenixDatasetCatalog,
  type PhoenixDatasetCatalog,
  type PhoenixExperimentDatasetReference,
} from "./phoenix.js";
import {
  appendEvaluationAttempt,
  completeEvaluationReport,
  createEvaluationReport,
  decodeEvaluationAttemptId,
  decodeEvaluationReportDigest,
  decodeEvaluationReportId,
  type EvaluationReportDigest,
  EvaluationCasePlan,
  EvaluationConditionPlan,
  EvaluationReportPlan,
  EvidenceRejectedAttempt,
  JudgePolicySnapshot,
  LocalEvaluationInfrastructure,
  LedgerAllocationFailedAttempt,
} from "./sweep.js";

const testImage = Schema.decodeSync(image);

const DATASET_NAME = "moltzap-evaluations";
const DATASET_DESCRIPTION =
  "MoltZap code-first behavioral evaluation cases (schema v1).";
const DATASET_VERSION_A = "dataset-version-a";
const DATASET_VERSION_B = "dataset-version-b";
const PHOENIX_BASE_URL = "https://phoenix.test";
const PHOENIX_SERVER_VERSION = "15.0.0";
const TEST_TIMESTAMP = "2026-07-29T00:00:00.000Z";
const decodeLedgerRef = Schema.decodeSync(ledgerRef);
const decodeLedgerDigest = Schema.decodeSync(ledgerDigest);

function emptyPhoenixClient(): PhoenixClient {
  return createClient({
    options: {
      baseUrl: PHOENIX_BASE_URL,
      fetch: () =>
        Effect.runPromise(
          Effect.succeed(Response.json({ data: [], next_cursor: null })),
        ),
    },
    getEnvironmentOptions: () => ({}),
  });
}

function completedReceipt(): CompletedLedgerReceipt {
  return CompletedLedgerReceipt.make({
    ledger: decodeLedgerRef("phoenix-test-ledger"),
    completion: LedgerCompletion.make({
      ledgerFormatVersion: 1,
      runId: "phoenix-test-run",
      recordCount: 1,
      artifacts: {
        manifest: decodeLedgerDigest("a".repeat(64)),
        records: decodeLedgerDigest("b".repeat(64)),
      },
    }),
  });
}

function plan(definitionId = "moltzap.test.phoenix/v1"): EvaluationReportPlan {
  return EvaluationReportPlan.make({
    sourceRevision: "phoenix-test-revision",
    cases: [
      EvaluationCasePlan.make({
        id: decodeEvaluationCaseId("EVAL-005"),
        definitionId,
        name: "Phoenix reconciliation",
        description: "A deterministic Phoenix catalog fixture.",
        rubric: "Preserve the exact case catalog.",
        criterionIds: [decodeCriterionId("EVAL-005.result/v1")],
        slices: ["privacy", "baseline"],
      }),
    ],
    conditions: [
      EvaluationConditionPlan.make({
        id: decodeConditionId("openclaw/v1"),
        runtimeName: "openclaw",
        runtimeConfiguration: {
          modelOverride: "provider/runtime-model",
          nativePolicy: {
            install: "workspace",
            flags: ["preserve", "verbatim"],
          },
        },
      }),
    ],
    judgePolicy: JudgePolicySnapshot.make({
      id: decodeJudgePolicyId("test-judge/v1"),
      provider: "test",
      model: "deterministic",
      reasoningEffort: "medium",
      structuredOutput: true,
      tools: "none",
      timeoutMillis: 1_000,
      maxRetries: 2,
    }),
    infrastructure: LocalEvaluationInfrastructure.make({
      profile: "local",
      controllerImage: testImage(`controller@sha256:${"a".repeat(64)}`),
      peerApplicationImage: testImage(`peer@sha256:${"b".repeat(64)}`),
      nanoclawApplicationImage: testImage(`nanoclaw@sha256:${"c".repeat(64)}`),
      temporalAddress: "127.0.0.1:7233",
      artifactDirectory: "/var/lib/moltzap/artifacts",
    }),
    samplesPerCell: 1,
  });
}

const unknownRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
const datasetUploadBody = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  inputs: Schema.NonEmptyArray(unknownRecord),
  outputs: Schema.NonEmptyArray(unknownRecord),
  metadata: Schema.NonEmptyArray(unknownRecord),
  example_ids: Schema.NonEmptyArray(Schema.NullOr(Schema.String)),
});
const experimentCreateBody = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  metadata: unknownRecord,
  repetitions: Schema.Int,
  version_id: Schema.optional(Schema.String),
});
const runCreateBody = Schema.Struct({
  dataset_example_id: Schema.NonEmptyString,
  output: Schema.Unknown,
  repetition_number: Schema.Int,
  start_time: Schema.NonEmptyString,
  end_time: Schema.NonEmptyString,
  error: Schema.NullOr(Schema.String),
});
const evaluationCreateBody = Schema.Struct({
  experiment_run_id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

interface FakeDataset {
  readonly id: string;
  readonly versionId: string;
  readonly name: string;
  readonly description: string;
  readonly exampleId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

type FakeExperiment = Types["V1"]["components"]["schemas"]["Experiment"];
type FakeRun = Types["V1"]["components"]["schemas"]["ExperimentRun"];

interface FakeEvaluation {
  readonly identity: string;
}

interface FakePhoenixState {
  readonly dataset: Option.Option<FakeDataset>;
  readonly experiments: readonly FakeExperiment[];
  readonly runs: readonly FakeRun[];
  readonly evaluations: readonly FakeEvaluation[];
  readonly datasetUploads: number;
  readonly experimentCreates: number;
  readonly runCreates: number;
  readonly evaluationUpserts: number;
}

interface FakePhoenixOptions {
  readonly concurrentExperiment?: {
    readonly conflictingMetadata?: boolean;
  };
}

interface FakePhoenix {
  readonly client: PhoenixClient;
  readonly snapshot: Effect.Effect<FakePhoenixState>;
  readonly driftFirstRun: Effect.Effect<void>;
}

function phoenixResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "x-phoenix-server-version": PHOENIX_SERVER_VERSION,
    },
  });
}

function datasetResponse(dataset: FakeDataset) {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    metadata: {},
    created_at: TEST_TIMESTAMP,
    updated_at: TEST_TIMESTAMP,
    example_count: 1,
  };
}

function experimentFrom(
  id: string,
  dataset: FakeDataset,
  body: typeof experimentCreateBody.Type,
  metadata: Readonly<Record<string, unknown>>,
): FakeExperiment {
  return {
    id,
    dataset_id: dataset.id,
    dataset_version_id: body.version_id ?? dataset.versionId,
    name: body.name,
    description: body.description,
    repetitions: body.repetitions,
    metadata,
    project_name: null,
    created_at: TEST_TIMESTAMP,
    updated_at: TEST_TIMESTAMP,
    example_count: 1,
    successful_run_count: 0,
    failed_run_count: 0,
    missing_run_count: 1,
  };
}

function requiredDataset(state: FakePhoenixState): Effect.Effect<FakeDataset> {
  return Option.match(state.dataset, {
    onNone: () => Effect.dieMessage("fake Phoenix has no dataset"),
    onSome: Effect.succeed,
  });
}

const completedReport = Effect.fn("test.completedPhoenixReport")(function* () {
  const reportPlan = plan();
  const condition = reportPlan.conditions[0];
  const evaluationCase = reportPlan.cases[0];
  const base = yield* createEvaluationReport(
    decodeEvaluationReportId("phoenix-publication"),
    reportPlan,
  );
  const attempt = EvidenceRejectedAttempt.make({
    attemptId: decodeEvaluationAttemptId(
      "phoenix-publication/openclaw/v1/EVAL-005/001",
    ),
    caseId: evaluationCase.id,
    conditionId: condition.id,
    sample: 1,
    startedAt: DateTime.unsafeMake(0),
    completedAt: DateTime.unsafeMake(1),
    receipt: completedReceipt(),
    detail: "the retained evidence is incomplete",
  });
  const withAttempt = yield* appendEvaluationAttempt(base, attempt);
  return yield* completeEvaluationReport(withAttempt);
});

/** The in-memory Phoenix transport received an unreadable request body. */
class FakePhoenixRequestFailed extends Schema.TaggedError<FakePhoenixRequestFailed>()(
  "FakePhoenixRequestFailed",
  { cause: Schema.Defect },
) {}

type FakeStateRef = Ref.Ref<FakePhoenixState>;
type FakeRouteHandler = (request: Request) => Effect.Effect<Response>;

function requestJson(request: Request): Effect.Effect<unknown> {
  return Effect.tryPromise({
    try: () => request.json(),
    catch: (cause) => FakePhoenixRequestFailed.make({ cause }),
  }).pipe(Effect.orDie);
}

function initialFakeState(): FakePhoenixState {
  return {
    dataset: Option.none(),
    experiments: [],
    runs: [],
    evaluations: [],
    datasetUploads: 0,
    experimentCreates: 0,
    runCreates: 0,
    evaluationUpserts: 0,
  };
}

function listFakeDatasets(state: FakeStateRef): Effect.Effect<Response> {
  return Ref.get(state).pipe(
    Effect.map((current) =>
      Option.match(current.dataset, {
        onNone: () => phoenixResponse({ data: [], next_cursor: null }),
        onSome: (dataset) =>
          phoenixResponse({
            data: [datasetResponse(dataset)],
            next_cursor: null,
          }),
      }),
    ),
  );
}

const uploadFakeDataset = Effect.fn("test.uploadFakeDataset")(function* (
  state: FakeStateRef,
  request: Request,
) {
  const unknown = yield* requestJson(request);
  const body = yield* Schema.decodeUnknown(datasetUploadBody)(unknown).pipe(
    Effect.orDie,
  );
  const exampleId = body.example_ids[0];
  if (exampleId === null) {
    return yield* Effect.dieMessage(
      "fake Phoenix requires one stable example id",
    );
  }
  const dataset = yield* Ref.modify(state, (current) => {
    const nextUpload = current.datasetUploads + 1;
    const created: FakeDataset = {
      id: "dataset-1",
      versionId: `dataset-version-${nextUpload}`,
      name: body.name,
      description: body.description,
      exampleId,
      input: body.inputs[0],
      output: body.outputs[0],
      metadata: body.metadata[0],
    };
    return [
      created,
      {
        ...current,
        dataset: Option.some(created),
        datasetUploads: nextUpload,
      },
    ];
  });
  return phoenixResponse({ data: { dataset_id: dataset.id } });
});

function getFakeDataset(state: FakeStateRef): Effect.Effect<Response> {
  return Ref.get(state).pipe(
    Effect.flatMap(requiredDataset),
    Effect.map((dataset) =>
      phoenixResponse({ data: datasetResponse(dataset) }),
    ),
  );
}

function getFakeDatasetExamples(state: FakeStateRef): Effect.Effect<Response> {
  return Ref.get(state).pipe(
    Effect.flatMap(requiredDataset),
    Effect.map((dataset) =>
      phoenixResponse({
        data: {
          version_id: dataset.versionId,
          examples: [
            {
              id: dataset.exampleId,
              node_id: `example-node-${dataset.exampleId}`,
              input: dataset.input,
              output: dataset.output,
              metadata: dataset.metadata,
              updated_at: TEST_TIMESTAMP,
            },
          ],
        },
      }),
    ),
  );
}

function listFakeExperiments(state: FakeStateRef): Effect.Effect<Response> {
  return Ref.get(state).pipe(
    Effect.map((current) =>
      phoenixResponse({ data: current.experiments, next_cursor: null }),
    ),
  );
}

function concurrentExperiment(
  options: FakePhoenixOptions,
  dataset: FakeDataset,
  body: typeof experimentCreateBody.Type,
): readonly FakeExperiment[] {
  if (options.concurrentExperiment === undefined) {
    return [];
  }
  const metadata =
    options.concurrentExperiment.conflictingMetadata === true
      ? { ...body.metadata, reportDigest: "remote-drift" }
      : body.metadata;
  return [experimentFrom("experiment-a", dataset, body, metadata)];
}

const createFakeExperiment = Effect.fn("test.createFakeExperiment")(function* (
  state: FakeStateRef,
  options: FakePhoenixOptions,
  request: Request,
) {
  const unknown = yield* requestJson(request);
  const body = yield* Schema.decodeUnknown(experimentCreateBody)(unknown).pipe(
    Effect.orDie,
  );
  const dataset = yield* Ref.get(state).pipe(Effect.flatMap(requiredDataset));
  const created = yield* Ref.modify(state, (current) => {
    const nextCreate = current.experimentCreates + 1;
    const id =
      options.concurrentExperiment === undefined
        ? `experiment-${nextCreate}`
        : "experiment-b";
    const experiment = experimentFrom(id, dataset, body, body.metadata);
    return [
      experiment,
      {
        ...current,
        experiments: [
          ...current.experiments,
          experiment,
          ...concurrentExperiment(options, dataset, body),
        ],
        experimentCreates: nextCreate,
      },
    ];
  });
  return phoenixResponse({ data: created });
});

function experimentId(request: Request): Effect.Effect<string> {
  const id = new URL(request.url).pathname.split("/")[3];
  return id === undefined
    ? Effect.dieMessage("fake Phoenix request has no experiment id")
    : Effect.succeed(id);
}

const getFakeExperiment = Effect.fn("test.getFakeExperiment")(function* (
  state: FakeStateRef,
  request: Request,
) {
  const id = yield* experimentId(request);
  const current = yield* Ref.get(state);
  const experiment = current.experiments.find(
    (candidate) => candidate.id === id,
  );
  return experiment === undefined
    ? phoenixResponse({ detail: "experiment not found" }, 404)
    : phoenixResponse({ data: experiment });
});

const listFakeRuns = Effect.fn("test.listFakeRuns")(function* (
  state: FakeStateRef,
  request: Request,
) {
  const id = yield* experimentId(request);
  const current = yield* Ref.get(state);
  return phoenixResponse({
    data: current.runs.filter((run) => run.experiment_id === id),
    next_cursor: null,
  });
});

const createFakeRun = Effect.fn("test.createFakeRun")(function* (
  state: FakeStateRef,
  request: Request,
) {
  const id = yield* experimentId(request);
  const unknown = yield* requestJson(request);
  const body = yield* Schema.decodeUnknown(runCreateBody)(unknown).pipe(
    Effect.orDie,
  );
  const run = yield* Ref.modify(state, (current) => {
    const nextCreate = current.runCreates + 1;
    const created: FakeRun = {
      ...body,
      id: `run-${nextCreate}`,
      experiment_id: id,
      trace_id: null,
    };
    return [
      created,
      {
        ...current,
        runs: [...current.runs, created],
        runCreates: nextCreate,
      },
    ];
  });
  return phoenixResponse({ data: run });
});

const upsertFakeEvaluation = Effect.fn("test.upsertFakeEvaluation")(function* (
  state: FakeStateRef,
  request: Request,
) {
  const unknown = yield* requestJson(request);
  const body = yield* Schema.decodeUnknown(evaluationCreateBody)(unknown).pipe(
    Effect.orDie,
  );
  yield* Ref.update(state, (current) => {
    const identity = `${body.experiment_run_id}/${body.name}`;
    const retained = current.evaluations.filter(
      (evaluation) => evaluation.identity !== identity,
    );
    return {
      ...current,
      evaluations: [...retained, { identity }],
      evaluationUpserts: current.evaluationUpserts + 1,
    };
  });
  return phoenixResponse({ data: {} });
});

function fakeRoutes(
  state: FakeStateRef,
  options: FakePhoenixOptions,
): ReadonlyMap<string, FakeRouteHandler> {
  const routes: ReadonlyArray<readonly [string, FakeRouteHandler]> = [
    ["GET /v1/datasets", () => listFakeDatasets(state)],
    [
      "POST /v1/datasets/upload",
      (request) => uploadFakeDataset(state, request),
    ],
    ["GET /v1/datasets/dataset-1", () => getFakeDataset(state)],
    [
      "GET /v1/datasets/dataset-1/examples",
      () => getFakeDatasetExamples(state),
    ],
    [
      "GET /v1/datasets/dataset-1/experiments",
      () => listFakeExperiments(state),
    ],
    [
      "POST /v1/datasets/dataset-1/experiments",
      (request) => createFakeExperiment(state, options, request),
    ],
    ["GET /v1/experiments/:id", (request) => getFakeExperiment(state, request)],
    ["GET /v1/experiments/:id/runs", (request) => listFakeRuns(state, request)],
    [
      "POST /v1/experiments/:id/runs",
      (request) => createFakeRun(state, request),
    ],
    [
      "POST /v1/experiment_evaluations",
      (request) => upsertFakeEvaluation(state, request),
    ],
  ];
  return new Map(routes);
}

function fakeRoutePath(pathname: string): string {
  if (/^\/v1\/experiments\/[^/]+\/runs$/u.test(pathname)) {
    return "/v1/experiments/:id/runs";
  }
  if (/^\/v1\/experiments\/[^/]+$/u.test(pathname)) {
    return "/v1/experiments/:id";
  }
  return pathname;
}

function makeFakeResponder(
  routes: ReadonlyMap<string, FakeRouteHandler>,
): FakeRouteHandler {
  return (request) => {
    const path = fakeRoutePath(new URL(request.url).pathname);
    const handler = routes.get(`${request.method} ${path}`);
    return handler === undefined
      ? Effect.succeed(
          phoenixResponse(
            {
              detail: `unexpected fake Phoenix route ${request.method} ${path}`,
            },
            404,
          ),
        )
      : handler(request);
  };
}

function fakePhoenixClient(respond: FakeRouteHandler): PhoenixClient {
  return createClient({
    options: {
      baseUrl: PHOENIX_BASE_URL,
      fetch: (request) => Effect.runPromise(respond(request)),
    },
    getEnvironmentOptions: () => ({}),
  });
}

function driftFirstRun(current: FakePhoenixState): FakePhoenixState {
  return {
    ...current,
    runs: current.runs.map((run, index) =>
      index === 0 ? { ...run, output: { remote: "drift" } } : run,
    ),
  };
}

function makeFakePhoenix(
  options: FakePhoenixOptions = {},
): Effect.Effect<FakePhoenix> {
  return Effect.gen(function* () {
    const state = yield* Ref.make(initialFakeState());
    const respond = makeFakeResponder(fakeRoutes(state, options));
    const client = yield* Effect.sync(() => fakePhoenixClient(respond));
    return {
      client,
      snapshot: Ref.get(state),
      driftFirstRun: Ref.update(state, driftFirstRun),
    };
  });
}

function fakeExperimentIds(state: FakePhoenixState): readonly string[] {
  return state.experiments.map((experiment) => experiment.id);
}

function fakeRunExperimentIds(state: FakePhoenixState): readonly string[] {
  return state.runs.map((run) => run.experiment_id);
}

function canonicalFakeExperimentId(
  state: FakePhoenixState,
): string | undefined {
  return [...fakeExperimentIds(state)].sort((left, right) =>
    left.localeCompare(right),
  )[0];
}

function experimentReference(
  reportPlan: EvaluationReportPlan,
  digest: EvaluationReportDigest,
  versionId: string,
  conditionIndex = 0,
): PhoenixExperimentDatasetReference {
  const condition =
    reportPlan.conditions[conditionIndex] ?? reportPlan.conditions[0];
  return {
    name: `moltzap/${digest}/${condition.id}`,
    dataset_version_id: versionId,
  };
}

function catalogFixture() {
  return Effect.gen(function* () {
    const reportPlan = plan();
    const example = phoenixCatalogExamples(reportPlan)[0];
    if (example === undefined) {
      return yield* Effect.dieMessage("test catalog must contain one example");
    }
    const dataset: PhoenixDatasetCatalog = {
      name: DATASET_NAME,
      description: DATASET_DESCRIPTION,
      examples: [example],
    };
    return { reportPlan, example, dataset };
  });
}

describe("Phoenix catalog reconciliation", () => {
  it.effect("treats an empty successful dataset page as absence", () =>
    Effect.gen(function* () {
      const dataset = yield* findPhoenixDataset(emptyPhoenixClient());

      assert.isUndefined(dataset);
    }),
  );

  it("stores the closed slice set once in readable metadata", () => {
    const examples = phoenixCatalogExamples(plan());
    const example = examples[0];

    assert.lengthOf(examples, 1);
    assert.deepStrictEqual(example?.metadata, {
      slices: ["baseline", "privacy"],
    });
    assert.notProperty(example, "splits");
  });

  it.effect("accepts the complete SDK-readable catalog", () =>
    Effect.gen(function* () {
      const { dataset, reportPlan } = yield* catalogFixture();

      yield* reconcilePhoenixDatasetCatalog(dataset, reportPlan);
    }),
  );

  it.effect("rejects remote example drift under the stable dataset name", () =>
    Effect.gen(function* () {
      const { dataset, example, reportPlan } = yield* catalogFixture();
      const failure = yield* reconcilePhoenixDatasetCatalog(
        {
          ...dataset,
          examples: [
            {
              ...example,
              input: { ...example.input, rubric: "remote drift" },
            },
          ],
        },
        reportPlan,
      ).pipe(Effect.flip);

      assert.instanceOf(failure, PhoenixPublicationConflict);
      assert.include(failure.detail, "remote examples differ");
    }),
  );
});

describe("Phoenix catalog version history", () => {
  it.effect("reuses the report's pinned catalog across A-B-A history", () =>
    Effect.gen(function* () {
      const planA = plan("moltzap.test.phoenix/a");
      const planB = plan("moltzap.test.phoenix/b");
      const digestA = decodeEvaluationReportDigest("a".repeat(64));
      const digestB = decodeEvaluationReportDigest("b".repeat(64));
      const afterA = [experimentReference(planA, digestA, DATASET_VERSION_A)];
      const beforeB = yield* phoenixPublishedDatasetVersion(
        digestB,
        planB,
        afterA,
      );
      const replayedA = yield* phoenixPublishedDatasetVersion(digestA, planA, [
        ...afterA,
        experimentReference(planB, digestB, DATASET_VERSION_B),
      ]);

      assert.notDeepEqual(
        phoenixCatalogExamples(planA),
        phoenixCatalogExamples(planB),
      );
      assert.isTrue(Option.isNone(beforeB));
      assert.deepStrictEqual(replayedA, Option.some(DATASET_VERSION_A));
    }),
  );
});

describe("Phoenix catalog version conflicts", () => {
  it.effect("rejects report conditions pinned to split catalog versions", () =>
    Effect.gen(function* () {
      const reportPlan = plan();
      const digest = decodeEvaluationReportDigest("c".repeat(64));
      const second = EvaluationConditionPlan.make({
        id: decodeConditionId("nanoclaw/v1"),
        runtimeName: "nanoclaw",
        runtimeConfiguration: { modelOverride: "provider/other-model" },
      });
      const splitPlan = EvaluationReportPlan.make({
        sourceRevision: reportPlan.sourceRevision,
        cases: reportPlan.cases,
        conditions: [reportPlan.conditions[0], second],
        judgePolicy: reportPlan.judgePolicy,
        infrastructure: reportPlan.infrastructure,
        samplesPerCell: reportPlan.samplesPerCell,
      });
      const failure = yield* phoenixPublishedDatasetVersion(digest, splitPlan, [
        experimentReference(splitPlan, digest, DATASET_VERSION_A),
        experimentReference(splitPlan, digest, DATASET_VERSION_B, 1),
      ]).pipe(Effect.flip);

      assert.instanceOf(failure, PhoenixPublicationConflict);
      assert.include(failure.detail, "different dataset versions");
    }),
  );
});

describe("Phoenix concurrent publication", () => {
  it.effect(
    "reconciles equivalent experiment identities created in one race",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePhoenix({
          concurrentExperiment: {},
        });
        const report = yield* completedReport();
        const publisher = makePhoenixPublisher(fake.client, PHOENIX_BASE_URL);
        const publication = yield* publisher.publish(report);
        const state = yield* fake.snapshot;
        const ids = fakeExperimentIds(state);

        assert.strictEqual(
          publication.experiments[0].experimentId,
          canonicalFakeExperimentId(state),
        );
        assert.lengthOf(state.experiments, 2);
        assert.notStrictEqual(publication.experiments[0].experimentId, ids[0]);
        assert.deepStrictEqual(fakeRunExperimentIds(state), [
          publication.experiments[0].experimentId,
        ]);
      }),
  );

  it.effect(
    "rejects a concurrent identity whose immutable metadata differs",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePhoenix({
          concurrentExperiment: { conflictingMetadata: true },
        });
        const report = yield* completedReport();
        const publisher = makePhoenixPublisher(fake.client, PHOENIX_BASE_URL);
        const failure = yield* publisher.publish(report).pipe(Effect.flip);
        const state = yield* fake.snapshot;

        assert.instanceOf(failure, PhoenixPublicationConflict);
        assert.include(failure.detail, "metadata differs");
        assert.lengthOf(state.experiments, 2);
        assert.lengthOf(state.runs, 0);
      }),
  );
});

describe("Phoenix repeated publication", () => {
  it.effect("converges on one dataset, experiment, run, and assessment", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhoenix();
      const report = yield* completedReport();
      const publisher = makePhoenixPublisher(fake.client, PHOENIX_BASE_URL);
      const first = yield* publisher.publish(report);
      const replay = yield* publisher.publish(report);
      const state = yield* fake.snapshot;

      assert.deepStrictEqual(replay, first);
      assert.deepStrictEqual(
        {
          datasetUploads: state.datasetUploads,
          experimentCreates: state.experimentCreates,
          runCreates: state.runCreates,
          evaluationUpserts: state.evaluationUpserts,
        },
        {
          datasetUploads: 1,
          experimentCreates: 1,
          runCreates: 1,
          evaluationUpserts: 2,
        },
      );
      assert.lengthOf(state.experiments, 1);
      assert.lengthOf(state.runs, 1);
      assert.deepStrictEqual(state.evaluations, [
        { identity: "run-1/moltzap.evidence" },
      ]);
    }),
  );

  it.effect("rejects remote run drift instead of overwriting local truth", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePhoenix();
      const report = yield* completedReport();
      const publisher = makePhoenixPublisher(fake.client, PHOENIX_BASE_URL);
      yield* publisher.publish(report);
      yield* fake.driftFirstRun;
      const failure = yield* publisher.publish(report).pipe(Effect.flip);
      const state = yield* fake.snapshot;

      assert.instanceOf(failure, PhoenixPublicationConflict);
      assert.strictEqual(failure.resource, "run");
      assert.strictEqual(state.runCreates, 1);
      assert.strictEqual(state.evaluationUpserts, 1);
    }),
  );
});

// @agent-code-guard/regression-only: the publisher must expose the exact immutable execution inputs in the Phoenix comparison surface
describe("Phoenix experiment provenance", () => {
  it.effect("exposes native runtime and judge metadata", () =>
    Effect.gen(function* () {
      const reportPlan = plan();
      const provenance = yield* phoenixExperimentProvenance(
        reportPlan,
        reportPlan.conditions[0],
      );

      assert.deepStrictEqual(provenance, {
        runtimeConfiguration: {
          modelOverride: "provider/runtime-model",
          nativePolicy: {
            install: "workspace",
            flags: ["preserve", "verbatim"],
          },
        },
        judgePolicy: {
          id: "test-judge/v1",
          provider: "test",
          model: "deterministic",
          reasoningEffort: "medium",
          structuredOutput: true,
          tools: "none",
          timeoutMillis: 1_000,
          maxRetries: 2,
        },
      });
    }),
  );
});

describe("Phoenix operational attempts", () => {
  it("retains ledger allocation failures as run data without assessments", () => {
    const reportPlan = plan();
    const condition = reportPlan.conditions[0];
    const attempt = LedgerAllocationFailedAttempt.make({
      attemptId: decodeEvaluationAttemptId("phoenix/openclaw/v1/EVAL-005/001"),
      caseId: reportPlan.cases[0].id,
      conditionId: condition.id,
      sample: 1,
      startedAt: DateTime.unsafeMake(0),
      completedAt: DateTime.unsafeMake(1),
      failure: LedgerStorageError.make({
        operation: "allocate",
        detail: "cannot create the ledger directory",
      }),
    });

    assert.deepStrictEqual(
      phoenixAttemptEvaluations(
        attempt,
        decodeEvaluationReportDigest("d".repeat(64)),
        condition,
      ),
      [],
    );
  });
});

describe("Phoenix evidence assessments", () => {
  it("publishes evidence rejection details without diagnostic vocabulary", () => {
    const reportPlan = plan();
    const condition = reportPlan.conditions[0];
    const attempt = EvidenceRejectedAttempt.make({
      attemptId: decodeEvaluationAttemptId("phoenix/openclaw/v1/EVAL-005/001"),
      caseId: reportPlan.cases[0].id,
      conditionId: condition.id,
      sample: 1,
      startedAt: DateTime.unsafeMake(0),
      completedAt: DateTime.unsafeMake(1),
      receipt: completedReceipt(),
      detail: "the retained evidence is incomplete",
    });

    assert.deepStrictEqual(
      phoenixAttemptEvaluations(
        attempt,
        decodeEvaluationReportDigest("d".repeat(64)),
        condition,
      ),
      [
        {
          name: "moltzap.evidence",
          annotatorKind: "CODE",
          result: null,
          error: "the retained evidence is incomplete",
          metadata: {
            source: "code",
            reportDigest: "d".repeat(64),
            conditionId: "openclaw/v1",
          },
        },
      ],
    );
  });
});
