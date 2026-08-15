/** @file The stable Phoenix dataset catalog and its remote reconciliation. */

import type { PhoenixClient } from "@arizeai/phoenix-client";
import { createDataset, getDataset } from "@arizeai/phoenix-client/datasets";
import { Effect, Option } from "effect";
import type { EvaluationReportDigest, EvaluationReportPlan } from "./sweep.js";
import {
  type PhoenixDataset,
  phoenixRequest,
  type PhoenixRequestFailed,
  requestFailure,
} from "./phoenix-client.js";
import {
  listExperiments,
  phoenixPublishedDatasetVersion,
} from "./phoenix-experiment.js";
import {
  conflict,
  type DatasetFailure,
  type PhoenixPublicationConflict,
  type PhoenixPublicationEncodingError,
  sameJson,
} from "./phoenix-publication.js";

const DATASET_NAME = "moltzap-evaluations";
const DATASET_DESCRIPTION =
  "MoltZap code-first behavioral evaluation cases (schema v1).";

/** SDK-readable dataset fields used during remote reconciliation. */
export interface PhoenixDatasetCatalog {
  readonly name: string;
  readonly description?: string | null;
  readonly examples: ReadonlyArray<{
    readonly id: string;
    readonly input: unknown;
    readonly output?: unknown;
    readonly metadata?: unknown;
  }>;
}

/**
 * Reach the dataset version this report publishes against.
 * @param client Configured Phoenix SDK client.
 * @param plan Immutable local report plan.
 * @param digest Stable local report digest.
 * @returns The already-pinned version when the report was published before,
 * otherwise the version left by refreshing the catalog.
 */
export function ensureDataset(
  client: PhoenixClient,
  plan: EvaluationReportPlan,
  digest: EvaluationReportDigest,
): Effect.Effect<PhoenixDataset, DatasetFailure> {
  return Effect.gen(function* () {
    const latest = yield* findPhoenixDataset(client);
    if (latest !== undefined) {
      const experiments = yield* listExperiments(client, latest.id);
      const publishedVersion = yield* phoenixPublishedDatasetVersion(
        digest,
        plan,
        experiments,
      );
      if (Option.isSome(publishedVersion)) {
        const published = yield* phoenixRequest(
          "get evaluation dataset version",
          () =>
            getDataset({
              client,
              dataset: {
                datasetId: latest.id,
                versionId: publishedVersion.value,
              },
            }),
        );
        return yield* reconcilePhoenixDatasetCatalog(published, plan).pipe(
          Effect.as(published),
        );
      }
    }
    yield* updateDatasetCatalog(client, plan);
    const updated = yield* findPhoenixDataset(client);
    if (updated !== undefined) {
      return yield* reconcilePhoenixDatasetCatalog(updated, plan).pipe(
        Effect.as(updated),
      );
    }
    return yield* Effect.fail(
      requestFailure(
        "get updated evaluation dataset",
        "dataset disappeared after update",
      ),
    );
  }).pipe(Effect.withSpan("evals.ensureDataset"));
}

/**
 * Reconcile remote dataset identity and examples without requiring a live
 * Phoenix client.
 * @param dataset Remote dataset projection.
 * @param plan Immutable local report plan.
 * @returns Completion when the projections agree.
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

/**
 * Canonical Phoenix dataset rows derived from the immutable case catalog.
 * @param plan Immutable case and condition catalog.
 * @returns Stable Phoenix examples in catalog order.
 */
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
    };
  });
}

/**
 * Find the stable dataset without asking the SDK to interpret an empty list.
 * @param client Configured Phoenix SDK client.
 * @returns The unique evaluation dataset when it exists.
 */
export function findPhoenixDataset(
  client: PhoenixClient,
): Effect.Effect<
  PhoenixDataset | undefined,
  PhoenixRequestFailed | PhoenixPublicationConflict
> {
  const operation = "find evaluation dataset";
  return Effect.gen(function* () {
    const response = yield* phoenixRequest(operation, () =>
      client.GET("/v1/datasets", {
        params: { query: { name: DATASET_NAME, limit: 2, cursor: null } },
      }),
    );
    const datasets = response.data?.data;
    if (datasets === undefined) {
      return yield* Effect.fail(
        requestFailure(operation, "Phoenix returned no dataset page"),
      );
    }
    const [dataset, ...duplicates] = datasets.filter(
      (candidate) => candidate.name === DATASET_NAME,
    );
    if (duplicates.length > 0) {
      return yield* Effect.fail(
        conflict("dataset", DATASET_NAME, "remote identity is not unique"),
      );
    }
    if (dataset === undefined) {
      return undefined;
    }
    return yield* phoenixRequest("get evaluation dataset", () =>
      getDataset({ client, dataset: { datasetId: dataset.id } }),
    );
  }).pipe(Effect.withSpan("evals.findPhoenixDataset"));
}

/**
 * Resolve the stable dataset example a case publishes its attempts against.
 * @param dataset Remote dataset holding the case catalog.
 * @param caseId Case whose example is needed.
 * @returns The example node ID, or a conflict when the case is missing or
 * duplicated remotely.
 */
export function datasetExampleId(
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

function updateDatasetCatalog(
  client: PhoenixClient,
  plan: EvaluationReportPlan,
): Effect.Effect<string, PhoenixRequestFailed> {
  return phoenixRequest("update evaluation dataset", () =>
    createDataset({
      client,
      name: DATASET_NAME,
      description: DATASET_DESCRIPTION,
      examples: phoenixCatalogExamples(plan),
    }),
  ).pipe(Effect.map(({ datasetId }) => datasetId));
}

function datasetExampleProjection(
  example: PhoenixDatasetCatalog["examples"][number],
) {
  return {
    id: example.id,
    input: example.input,
    output: example.output ?? {},
    metadata: example.metadata ?? {},
  };
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
