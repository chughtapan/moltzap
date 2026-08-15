/** @file Per-condition Phoenix experiments: identity, provenance, and reconciliation. */

import type { PhoenixClient } from "@arizeai/phoenix-client";
import { createExperiment } from "@arizeai/phoenix-client/experiments";
import {
  jsonValue,
  type JsonValue as JsonValueType,
} from "@moltzap/simulator/ledger";
import { Effect, Option, Schema } from "effect";
import {
  PAGE_SIZE,
  type PhoenixExperiment,
  type PhoenixExperimentsPage,
  phoenixRequest,
  type PhoenixRequestFailed,
  requestFailure,
} from "./phoenix-client.js";
import {
  conflict,
  type DatasetFailure,
  encodingError,
  FIRST_REPETITION,
  PHOENIX_PUBLICATION_FORMAT_VERSION,
  type PhoenixPublicationConflict,
  type PhoenixPublicationEncodingError,
  type PublicationContext,
  sameJson,
} from "./phoenix-publication.js";
import {
  type CompletedEvaluationReport,
  type EvaluationConditionPlan,
  type EvaluationReportDigest,
  type EvaluationReportPlan,
  JudgePolicySnapshot,
} from "./sweep.js";

/**
 * Reach the one experiment for a condition, creating it only when absent.
 * @param context Remote dataset and validated local report being published.
 * @param condition Runtime condition the experiment projects.
 * @returns The experiment whose identity and metadata match the local report.
 */
export function ensureExperiment(
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
    if (matches.length > 0) {
      return yield* reconcileExperiments(matches, context, condition);
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
        experimentDescription: `MoltZap evaluation report ${context.report.reportId}, condition ${condition.id}.`,
        experimentMetadata: metadata,
        repetitions: FIRST_REPETITION,
      }),
    );
    const remote = yield* fetchExperiment(context.client, created.id);
    const refreshed = yield* listExperiments(
      context.client,
      context.dataset.id,
    );
    const candidates = new Map(
      refreshed
        .filter((experiment) => experiment.name === identity)
        .map((experiment) => [experiment.id, experiment] as const),
    );
    candidates.set(remote.id, remote);
    return yield* reconcileExperiments(
      Array.from(candidates.values()),
      context,
      condition,
    );
  }).pipe(Effect.withSpan("evals.ensureExperiment"));
}

/**
 * Read every experiment attached to one dataset, following Phoenix pagination.
 * @param client Configured Phoenix SDK client.
 * @param datasetId Remote dataset whose experiments are listed.
 * @returns All experiments across every page, in Phoenix order.
 */
export function listExperiments(
  client: PhoenixClient,
  datasetId: string,
): Effect.Effect<readonly PhoenixExperiment[], PhoenixRequestFailed> {
  return fetchExperimentsPage(client, datasetId, null).pipe(
    Effect.flatMap((page) =>
      collectExperimentPage(client, datasetId, page, []),
    ),
  );
}

/**
 * Find the dataset version already pinned by a report's experiments.
 * @param digest Stable local report digest.
 * @param plan Immutable local report plan.
 * @param experiments Remote experiment references.
 * @returns The one pinned version, if the report is already published.
 */
export function phoenixPublishedDatasetVersion(
  digest: EvaluationReportDigest,
  plan: EvaluationReportPlan,
  experiments: readonly PhoenixExperimentDatasetReference[],
): Effect.Effect<Option.Option<string>, PhoenixPublicationConflict> {
  const identities = new Set(
    plan.conditions.map((condition) => experimentName(digest, condition)),
  );
  const versions = new Set(
    experiments
      .filter((experiment) => identities.has(experiment.name))
      .map((experiment) => experiment.dataset_version_id),
  );
  const mismatch = conflict(
    "experiment",
    digest,
    "report experiments use different dataset versions",
  );
  return versions.size > 1
    ? Effect.fail(mismatch)
    : Effect.succeed(Option.fromIterable(versions));
}

/**
 * Runtime and judge inputs exposed on each condition experiment.
 * @param plan Immutable local report plan.
 * @param condition Runtime condition projected by the experiment.
 * @returns JSON-safe runtime and judge provenance.
 */
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
    Effect.flatMap(Schema.decodeUnknown(jsonValue)),
    Effect.map((judgePolicy) => ({
      runtimeConfiguration: condition.runtimeConfiguration,
      judgePolicy,
    })),
    Effect.mapError((cause) =>
      encodingError(`cannot encode experiment provenance: ${cause.message}`),
    ),
  );
}

function collectExperimentPage(
  client: PhoenixClient,
  datasetId: string,
  page: PhoenixExperimentsPage,
  collected: readonly PhoenixExperiment[],
): Effect.Effect<readonly PhoenixExperiment[], PhoenixRequestFailed> {
  const next = [...collected, ...page.data];
  if (page.next_cursor === null) {
    return Effect.succeed(next);
  }
  return fetchExperimentsPage(client, datasetId, page.next_cursor).pipe(
    Effect.flatMap((nextPage) =>
      collectExperimentPage(client, datasetId, nextPage, next),
    ),
  );
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

function selectCanonicalExperiment<Experiment extends { readonly id: string }>(
  experiments: readonly Experiment[],
): Experiment | undefined {
  return [...experiments].sort((left, right) =>
    left.id.localeCompare(right.id),
  )[0];
}

/** Dataset version fields retained by an existing Phoenix experiment. */
export type PhoenixExperimentDatasetReference = Pick<
  PhoenixExperiment,
  "name" | "dataset_version_id"
>;

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
    const expectedMetadata = yield* experimentMetadata(
      context.report,
      context.digest,
      condition,
    );
    const metadataMatches = yield* sameJson(
      experiment.metadata,
      expectedMetadata,
    );
    const matches = [
      experiment.name === identity,
      experiment.description ===
        `MoltZap evaluation report ${context.report.reportId}, condition ${condition.id}.`,
      experiment.dataset_id === context.dataset.id,
      experiment.dataset_version_id === context.dataset.versionId,
      experiment.repetitions === FIRST_REPETITION,
      metadataMatches,
    ].every(Boolean);
    if (!matches) {
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

function experimentName(
  digest: EvaluationReportDigest,
  condition: EvaluationConditionPlan,
): string {
  return `moltzap/${digest}/${condition.id}`;
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

function reconcileExperiments(
  experiments: readonly PhoenixExperiment[],
  context: PublicationContext,
  condition: EvaluationConditionPlan,
): Effect.Effect<
  PhoenixExperiment,
  PhoenixPublicationConflict | PhoenixPublicationEncodingError
> {
  return Effect.gen(function* () {
    const validated = yield* Effect.forEach(
      experiments,
      (experiment) => validateExperiment(experiment, context, condition),
      { concurrency: 1 },
    );
    const canonical = selectCanonicalExperiment(validated);
    if (canonical !== undefined) {
      return canonical;
    }
    return yield* Effect.fail(
      conflict(
        "experiment",
        experimentName(context.digest, condition),
        "remote identity disappeared during reconciliation",
      ),
    );
  });
}
