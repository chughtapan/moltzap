/** @file Publication failure vocabulary and the canonical JSON comparison it relies on. */

import type { PhoenixClient } from "@arizeai/phoenix-client";
import { jsonValue } from "@moltzap/simulator/ledger";
import { Effect, Schema } from "effect";
import type { PhoenixDataset, PhoenixRequestFailed } from "./phoenix-client.js";
import {
  canonicalJson,
  type CompletedEvaluationReport,
  type EvaluationReportDigest,
} from "./sweep.js";

/** Publication format the remote experiment metadata declares. */
export const PHOENIX_PUBLICATION_FORMAT_VERSION = 1;
/** Every attempt publishes as the first and only repetition. */
export const FIRST_REPETITION = 1;

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

/** Closed set of failures that stop publication without changing the report. */
export type PhoenixPublicationError =
  | PhoenixRequestFailed
  | PhoenixPublicationConflict
  | PhoenixPublicationEncodingError;

/** Failures reachable while reconciling datasets, experiments, and runs. */
export type DatasetFailure =
  | PhoenixRequestFailed
  | PhoenixPublicationConflict
  | PhoenixPublicationEncodingError;

/** Remote and local state shared by every step of one report publication. */
export interface PublicationContext {
  readonly client: PhoenixClient;
  readonly dataset: PhoenixDataset;
  readonly report: CompletedEvaluationReport;
  readonly digest: EvaluationReportDigest;
}

/**
 * Report data that Phoenix cannot represent.
 * @param detail What could not be encoded.
 * @returns A failure that stops publication before any remote write.
 */
export function encodingError(detail: string): PhoenixPublicationEncodingError {
  return PhoenixPublicationEncodingError.make({ detail });
}

/**
 * Report remote state that contradicts a stable publication identity.
 * @param resource Which Phoenix resource disagrees.
 * @param identity The stable identity under which the disagreement was found.
 * @param detail What differs between local and remote state.
 * @returns A failure that leaves the remote resource untouched.
 */
export function conflict(
  resource: PhoenixPublicationConflict["resource"],
  identity: string,
  detail: string,
): PhoenixPublicationConflict {
  return PhoenixPublicationConflict.make({ resource, identity, detail });
}

function canonicalUnknown(
  value: unknown,
): Effect.Effect<string, PhoenixPublicationEncodingError> {
  return Schema.decodeUnknown(jsonValue)(value).pipe(
    Effect.map(canonicalJson),
    Effect.mapError((cause) =>
      encodingError(`Phoenix value is not JSON: ${cause.message}`),
    ),
  );
}

/**
 * Compare two values by canonical JSON so key order never causes a false conflict.
 * @param left One value, typically the remote projection.
 * @param right The other value, typically the expected local projection.
 * @returns True when both encode to identical canonical JSON.
 */
export function sameJson(
  left: unknown,
  right: unknown,
): Effect.Effect<boolean, PhoenixPublicationEncodingError> {
  return Effect.all({
    left: canonicalUnknown(left),
    right: canonicalUnknown(right),
  }).pipe(Effect.map(({ left, right }) => left === right));
}
