/** @file The single Phoenix SDK boundary: typed request failures and Promise adaptation. */

import type { getDataset } from "@arizeai/phoenix-client/datasets";
import type { getExperimentRuns } from "@arizeai/phoenix-client/experiments";
import { HttpError, type Types } from "@arizeai/phoenix-client";
import { Effect, Schema } from "effect";

/** Page size requested from every paginated Phoenix listing. */
export const PAGE_SIZE = 100;

/** Dataset projection as the Phoenix SDK returns it. */
export type PhoenixDataset = Awaited<ReturnType<typeof getDataset>>;
/** One experiment record in the Phoenix v1 API. */
export type PhoenixExperiment =
  Types["V1"]["components"]["schemas"]["Experiment"];
/** One page of a dataset's experiments in the Phoenix v1 API. */
export type PhoenixExperimentsPage =
  Types["V1"]["components"]["schemas"]["ListExperimentsResponseBody"];
/** One experiment run as the Phoenix SDK returns it. */
export type PhoenixRun = Awaited<
  ReturnType<typeof getExperimentRuns>
>["runs"][number];

/** Phoenix or its transport rejected one request. */
export class PhoenixRequestFailed extends Schema.TaggedError<PhoenixRequestFailed>()(
  "PhoenixRequestFailed",
  {
    operation: Schema.NonEmptyString,
    detail: Schema.NonEmptyString,
    status: Schema.optional(Schema.Int),
  },
) {}

/* eslint-disable agent-code-guard/promise-type -- the Phoenix SDK exposes Promise APIs, which enter Effect only through this adapter. */
/**
 * The only Promise-to-Effect adaptation used by the publisher.
 * @param operation Human-readable name used when the call rejects.
 * @param evaluate Thunk invoking one Phoenix SDK call.
 * @returns The SDK result, or a typed request failure.
 */
export function phoenixRequest<A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, PhoenixRequestFailed> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => requestFailure(operation, cause),
  });
}
/* eslint-enable agent-code-guard/promise-type -- the Phoenix SDK boundary ends here. */

/**
 * Describe a rejected Phoenix call as a typed failure.
 * @param operation Human-readable name of the attempted call.
 * @param cause Value the SDK or transport threw.
 * @returns The failure, carrying the HTTP status when Phoenix reported one so
 * callers can distinguish conflicts from outages.
 */
export function requestFailure(
  operation: string,
  cause: unknown,
): PhoenixRequestFailed {
  return PhoenixRequestFailed.make({
    operation,
    detail: describeUnknown(cause),
    ...(cause instanceof HttpError ? { status: cause.status } : {}),
  });
}

/**
 * Recover readable text from anything the SDK or transport threw.
 * @param cause Arbitrary thrown value.
 * @returns The error message when one exists, otherwise a stringified form;
 * never the empty string.
 */
export function describeUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  const detail = String(cause);
  return detail.length > 0 ? detail : "unknown Phoenix failure";
}
