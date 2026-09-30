/** @file Classifies Router client failures as outages or rejections. */

import { type Effect, Schedule } from "effect";
import {
  routerWorkerBlipSchedule,
  RouterWorkerRejectedError,
  type RouterWorkerServices,
  RouterWorkerTransportError,
} from "./types.js";

/** Every failure the Router client raises; poll and send share one union. */
type RouterCallError = Effect.Effect.Error<
  ReturnType<RouterWorkerServices["router"]["poll"]>
>;

/** Any tagged worker failure. */
type TaggedFailure = Readonly<{ _tag: string }>;

/** Worker failure a Router call maps to. */
export type RouterCallFailure =
  | RouterWorkerTransportError
  | RouterWorkerRejectedError;

const transportFailure = () => new RouterWorkerTransportError();
const rejectedFailure = (reason: RouterWorkerRejectedError["reason"]) => () =>
  new RouterWorkerRejectedError({ reason });

/**
 * Outage-shaped Router failures (unreachable, timed out, 429, 5xx) are
 * transport failures the worker waits out. A refusal of the request itself
 * (401, 412 version mismatch, other 4xx, an undecodable answer, or a local
 * signing failure) cannot succeed on retry and is a rejection.
 */
const routerFailureByTag = {
  AgentSigningError: rejectedFailure("signing"),
  AuthenticationFailedError: rejectedFailure("authentication"),
  InternalServerError: transportFailure,
  MalformedRequestError: rejectedFailure("request"),
  MethodNotAllowedError: rejectedFailure("request"),
  OverloadedError: transportFailure,
  PayloadTooLargeError: rejectedFailure("request"),
  RouteNotFoundError: rejectedFailure("request"),
  RouterConnectionError: transportFailure,
  RouterInvalidResponseError: rejectedFailure("response"),
  RouterRequestTimeoutError: transportFailure,
  UnavailableError: transportFailure,
  UnsupportedMediaTypeError: rejectedFailure("request"),
  VersionMismatchError: rejectedFailure("version"),
} as const satisfies Readonly<
  Record<RouterCallError["_tag"], () => RouterCallFailure>
>;

/**
 * Classify one Router client failure as an outage or a rejection.
 * @param error Failure the Router client raised.
 * @returns The worker failure it maps to.
 */
export const mapRouterFailure = (error: RouterCallError): RouterCallFailure =>
  routerFailureByTag[error._tag]();

/**
 * Whether a worker failure is a Router outage rather than a rejection.
 * @param error Any tagged worker failure.
 * @returns True for `RouterWorkerTransportError`.
 */
export const isTransportFailure = (error: TaggedFailure): boolean =>
  error._tag === "RouterWorkerTransportError";

/** Quick retries of one Router poll, for transport failures only. */
export const pollBlipRetry = routerWorkerBlipSchedule.pipe(
  Schedule.whileInput(isTransportFailure),
);
