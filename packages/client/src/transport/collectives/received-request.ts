/**
 * @file The requests a member endpoint received, and which one an answer
 * answers.
 *
 * An answer names no request: the model sends it to the conversation its
 * request arrived in, and the endpoint matches it to the one request open
 * there. Answering one of several open requests in a conversation is not
 * supported, so that answer is refused rather than guessed.
 */

import { Either } from "effect";
import type { MessageAddressInput } from "../messaging/address.js";
import type { CollectiveFailure, CollectiveId } from "./forms.js";

/**
 * What matching reads of a received request: `to` is the conversation it
 * arrived in. `sending` holds the one answer in flight, so a member answers
 * at most once; an all_gather request becomes `closed` at its close.
 */
export interface RequestStatus {
  readonly to: MessageAddressInput;
  readonly deadlineAt: number;
  readonly state: "open" | "sending" | "answered" | "closed";
}

/** The one request an answer answers, with its id. */
export interface OpenRequest<Request extends RequestStatus> {
  readonly id: CollectiveId;
  readonly request: Request;
}

/** Why no single request takes an answer. */
type UnmatchedAnswer = Extract<
  CollectiveFailure["kind"],
  `request-${"none" | "ambiguous" | "answered" | "expired"}`
>;

/**
 * Find the one request open in a conversation: received, not yet answered,
 * and before its deadline and close.
 * @param requests Every request this endpoint holds, by id.
 * @param conversation The canonical address the answer is sent to.
 * @param now The current time in epoch milliseconds.
 * @returns The open request, or why none takes the answer: several are open,
 *   one was already answered, none was received, or each has expired.
 */
export const matchOpenRequest = <Request extends RequestStatus>(
  requests: ReadonlyMap<CollectiveId, Request>,
  conversation: MessageAddressInput,
  now: number,
): Either.Either<OpenRequest<Request>, UnmatchedAnswer> => {
  const asked = [...requests]
    .filter(([, request]) => request.to === conversation)
    .map(([id, request]) => ({
      id,
      request,
      unavailable: requestUnavailable(request, now),
    }));
  const open = asked.filter(({ unavailable }) => unavailable === undefined);
  const [only] = open;
  if (only !== undefined && open.length === 1) {
    return Either.right({ id: only.id, request: only.request });
  }
  if (open.length > 1) {
    return Either.left("request-ambiguous");
  }
  if (asked.some(({ unavailable }) => unavailable === "request-answered")) {
    return Either.left("request-answered");
  }
  return Either.left(asked.length === 0 ? "request-none" : "request-expired");
};

function requestUnavailable(
  request: RequestStatus,
  now: number,
): "request-answered" | "request-expired" | undefined {
  switch (request.state) {
    case "open":
      return now >= request.deadlineAt ? "request-expired" : undefined;
    case "sending":
    case "answered":
      return "request-answered";
    case "closed":
      return "request-expired";
    default: {
      const exhaustive: never = request.state;
      return exhaustive;
    }
  }
}
