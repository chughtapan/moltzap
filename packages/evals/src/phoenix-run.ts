/** @file Experiment runs: one idempotent Phoenix run per terminal local attempt. */

import type { PhoenixClient } from "@arizeai/phoenix-client";
import { getExperimentRuns } from "@arizeai/phoenix-client/experiments";
import {
  jsonValue,
  type JsonValue as JsonValueType,
} from "@moltzap/simulator/ledger";
import { DateTime, Effect, Schema } from "effect";
import {
  PAGE_SIZE,
  phoenixRequest,
  type PhoenixRequestFailed,
  type PhoenixRun,
  requestFailure,
} from "./phoenix-client.js";
import {
  conflict,
  type DatasetFailure,
  encodingError,
  FIRST_REPETITION,
  type PhoenixPublicationConflict,
  type PhoenixPublicationEncodingError,
  sameJson,
} from "./phoenix-publication.js";
import { type TerminalAttempt, terminalAttempt } from "./sweep.js";

/**
 * Reach the one run for a terminal attempt, creating it only when absent.
 * @param context Experiment and the runs it already holds.
 * @param attempt Validated terminal matrix attempt.
 * @param datasetExampleId Stable dataset example the attempt scores against.
 * @returns The run ID, after proving remote state matches the local attempt.
 */
export function ensureRun(
  context: RunContext,
  attempt: TerminalAttempt,
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
  }).pipe(Effect.withSpan("evals.ensureRun"));
}

/**
 * Read every run already recorded on one experiment.
 * @param client Configured Phoenix SDK client.
 * @param experimentId Experiment whose runs are read.
 * @returns The remote runs, used to make publication idempotent.
 */
export function fetchRuns(
  client: PhoenixClient,
  experimentId: string,
): Effect.Effect<readonly PhoenixRun[], PhoenixRequestFailed> {
  return phoenixRequest("get evaluation experiment runs", () =>
    getExperimentRuns({ client, experimentId, pageSize: PAGE_SIZE }),
  ).pipe(Effect.map(({ runs }) => runs));
}

function expectedRun(
  attempt: TerminalAttempt,
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

function encodeAttempt(
  attempt: TerminalAttempt,
): Effect.Effect<JsonValueType, PhoenixPublicationEncodingError> {
  return Schema.encode(terminalAttempt)(attempt, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(jsonValue)),
    Effect.mapError((cause) =>
      encodingError(
        `cannot encode attempt ${attempt.attemptId}: ${cause.message}`,
      ),
    ),
  );
}

function runError(attempt: TerminalAttempt): string | null {
  switch (attempt._tag) {
    case "RunFailedAttempt":
      return `${attempt._tag}: ${attempt.detail}`;
    case "LedgerAllocationFailedAttempt":
      return `${attempt._tag}: ${attempt.failure.detail}`;
    case "AssessedAttempt":
    case "EvidenceRejectedAttempt":
    case "JudgingUnavailableAttempt":
      return null;
    default:
      return attempt;
  }
}

interface ExpectedRun {
  readonly datasetExampleId: string;
  readonly output: JsonValueType;
  readonly error: string | null;
  readonly startTime: string;
  readonly endTime: string;
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

function uniqueRunByExample(
  runs: readonly PhoenixRun[],
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

/** Remote run state for one experiment while its attempts are published. */
export interface RunContext {
  readonly client: PhoenixClient;
  readonly experimentId: string;
  readonly runs: readonly PhoenixRun[];
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
    if (raced === undefined) {
      return yield* Effect.fail(creationError);
    }
    const validated = yield* validateRun(raced, expected, attemptId);
    return validated.id;
  });
}
