/** @file Idempotent Phoenix materialization for completed evaluation reports. */

import { createClient, type PhoenixClient } from "@arizeai/phoenix-client";
import { getExperimentUrl } from "@arizeai/phoenix-client/utils/urlUtils";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { conditionId } from "./model.js";
import {
  describeUnknown,
  type PhoenixRequestFailed,
  type PhoenixRun,
} from "./phoenix-client.js";
import { datasetExampleId, ensureDataset } from "./phoenix-dataset.js";
import { ensureExperiment } from "./phoenix-experiment.js";
import {
  encodingError,
  phoenixAttemptEvaluations,
  type PhoenixPublicationError,
  type PublicationContext,
  upsertEvaluation,
} from "./phoenix-publication.js";
import { ensureRun, fetchRuns } from "./phoenix-run.js";
import {
  type CompletedEvaluationReport,
  digestEvaluationReport,
  type EvaluationConditionPlan,
  evaluationReportDigest,
  type EvaluationReportValidationError,
  type TerminalAttempt,
  validateCompletedEvaluationReport,
} from "./sweep.js";

/** Re-exports the public API from `./phoenix-publication.js`. */
export {
  phoenixAttemptEvaluations,
  PhoenixPublicationConflict,
} from "./phoenix-publication.js";
/** Re-exports the public API from `./phoenix-dataset.js`. */
export {
  findPhoenixDataset,
  phoenixCatalogExamples,
  type PhoenixDatasetCatalog,
  reconcilePhoenixDatasetCatalog,
} from "./phoenix-dataset.js";
/** Re-exports the public API from `./phoenix-experiment.js`. */
export {
  type PhoenixExperimentDatasetReference,
  phoenixExperimentProvenance,
  phoenixPublishedDatasetVersion,
} from "./phoenix-experiment.js";

/** Published experiment location for one runtime condition. */
class PhoenixExperimentPublication extends Schema.Class<PhoenixExperimentPublication>(
  "PhoenixExperimentPublication",
)({
  conditionId,
  experimentId: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
}) {}

/** Immutable publication receipt returned without changing the local report. */
class PhoenixPublication extends Schema.Class<PhoenixPublication>(
  "PhoenixPublication",
)({
  datasetId: Schema.NonEmptyString,
  reportDigest: evaluationReportDigest,
  experiments: Schema.NonEmptyArray(PhoenixExperimentPublication),
}) {}

type PublishFailure = EvaluationReportValidationError | PhoenixPublicationError;

/** Publishes immutable completed reports as a Phoenix comparison view. */
export interface PhoenixPublisherService {
  readonly publish: (
    report: CompletedEvaluationReport,
  ) => Effect.Effect<PhoenixPublication, PublishFailure>;
}

/** Completed-report publication boundary. */
export class PhoenixPublisher extends Context.Tag(
  "@moltzap/evals/PhoenixPublisher",
)<PhoenixPublisher, PhoenixPublisherService>() {}

interface ConditionPublicationContext {
  readonly publication: PublicationContext;
  readonly condition: EvaluationConditionPlan;
  readonly experimentId: string;
  readonly remoteRuns: readonly PhoenixRun[];
}

/**
 * Build the Phoenix projection service around an injected SDK client.
 * @param client Configured Phoenix SDK client.
 * @param baseUrl Phoenix browser origin used for receipt links.
 * @returns A publisher that keeps the local report authoritative.
 */
export function makePhoenixPublisher(
  client: PhoenixClient,
  baseUrl: string,
): PhoenixPublisherService {
  const publish = Effect.fn("evals.publishPhoenixReport")(function* (
    report: CompletedEvaluationReport,
  ) {
    const validated = yield* validateCompletedEvaluationReport(report);
    const digest = yield* digestEvaluationReport(validated);
    const dataset = yield* ensureDataset(client, validated.plan, digest);
    const publication: PublicationContext = {
      client,
      dataset,
      report: validated,
      digest,
    };
    const [firstCondition, ...remainingConditions] = validated.plan.conditions;
    const first = yield* publishCondition(publication, baseUrl, firstCondition);
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
  });
  return {
    publish,
  };
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
    const url = yield* Effect.try({
      try: () =>
        getExperimentUrl({
          baseUrl,
          datasetId: publication.dataset.id,
          experimentId: experiment.id,
        }),
      catch: (cause) =>
        encodingError(
          `cannot construct Phoenix experiment URL: ${describeUnknown(cause)}`,
        ),
    });
    return PhoenixExperimentPublication.make({
      conditionId: condition.id,
      experimentId: experiment.id,
      url,
    });
  });
}

function publishAttempt(
  context: ConditionPublicationContext,
  attempt: TerminalAttempt,
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

function publishAttemptEvaluations(
  context: ConditionPublicationContext,
  runId: string,
  attempt: TerminalAttempt,
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

const phoenixHost = Config.string("PHOENIX_HOST");
const phoenixApiKey = Config.option(Config.redacted("PHOENIX_API_KEY"));

/** Externally managed Phoenix connection configured only through Effect. */
export const phoenixPublisherLive = Layer.effect(
  PhoenixPublisher,
  Effect.gen(function* () {
    const baseUrl = yield* phoenixHost;
    const apiKey = yield* phoenixApiKey;
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
