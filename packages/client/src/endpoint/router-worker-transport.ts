/** @file Private Router worker anchoring, retry, and re-envelope transport. */

import type {
  RouterInstanceId,
  RouterPollResult,
  RouterSendResult,
} from "@moltzap/router";
import {
  MessageId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Effect, Schedule, Schema } from "effect";
import { randomBytes } from "node:crypto";
import {
  type RouterTailAnchor,
  type RouterWorkerInput,
  RouterWorkerProtocolError,
  routerWorkerRetryAttempts,
  routerWorkerRetryDelay,
  type RouterWorkerRuntime,
  type RouterWorkerSendOutcome,
  type RouterWorkerServices,
  RouterWorkerTransportError,
} from "./router-worker-types.js";

/** Bounded fixed-delay policy for poll-loop retries. */
export const routerWorkerRetrySchedule = Schedule.fixed(
  routerWorkerRetryDelay,
).pipe(Schedule.intersect(Schedule.recurs(routerWorkerRetryAttempts - 1)));

const mapTransportError = () => new RouterWorkerTransportError();
const mapProtocolError = () => new RouterWorkerProtocolError();

const anchorFromOmittedResult = (
  result: RouterPollResult,
): Effect.Effect<RouterTailAnchor, RouterWorkerProtocolError> =>
  result.kind === "batch" && result.signedMessages.length === 0
    ? Effect.succeed({
        routerInstanceId: result.routerInstanceId,
        pollCursor: result.pollCursor,
      })
    : Effect.fail(new RouterWorkerProtocolError());

/**
 * Learn one Router instance and empty-tail cursor without replay.
 * @param services Resolved Router and Registry capabilities.
 * @param caller Authenticated local endpoint identity.
 * @returns The immediate empty-tail Router position.
 */
export const pollRouterTail = (
  services: RouterWorkerServices,
  caller: Pick<
    RouterWorkerInput<unknown>,
    "callerAgentId" | "signingAuthority"
  >,
): Effect.Effect<
  RouterTailAnchor,
  RouterWorkerTransportError | RouterWorkerProtocolError
> =>
  services.router
    .poll({
      request: {},
      callerAgentId: caller.callerAgentId,
      signingAuthority: caller.signingAuthority,
    })
    .pipe(
      Effect.retry(routerWorkerRetrySchedule),
      Effect.mapError(mapTransportError),
      Effect.flatMap(anchorFromOmittedResult),
      Effect.interruptible,
    );

const makeRandomMessageId = (): Effect.Effect<
  MessageId,
  RouterWorkerProtocolError
> =>
  Effect.try({
    try: () => `msg_${randomBytes(16).toString("base64url")}`,
    catch: mapProtocolError,
  }).pipe(
    Effect.flatMap((candidate) =>
      Schema.decodeUnknown(MessageId)(candidate).pipe(
        Effect.mapError(mapProtocolError),
      ),
    ),
  );

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
};

const recipientsEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((agentId, index) => agentId === right[index]);

const rewrapOuterDefault = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  signedMessage: SignedMessageValue,
  messageId: MessageId,
): Effect.Effect<SignedMessageValue, RouterWorkerProtocolError> =>
  SignedMessage.sign({
    agentCard: runtime.input.callerAgentCard,
    signingAuthority: runtime.input.signingAuthority,
    recipientAgentIds: new Set(signedMessage.recipientAgentIds),
    messageId,
    body: signedMessage.body,
  }).pipe(Effect.mapError(mapProtocolError));

const validateRewrapped = (
  previous: SignedMessageValue,
  next: SignedMessageValue,
): Effect.Effect<SignedMessageValue, RouterWorkerProtocolError> => {
  const sameEnvelopeBinding =
    previous.senderAgentId === next.senderAgentId &&
    previous.messageId !== next.messageId;
  const sameOpaqueAttempt =
    recipientsEqual(previous.recipientAgentIds, next.recipientAgentIds) &&
    bytesEqual(previous.body, next.body);
  return sameEnvelopeBinding && sameOpaqueAttempt
    ? Effect.succeed(next)
    : Effect.fail(new RouterWorkerProtocolError());
};

const rewrapOuter = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  signedMessage: SignedMessageValue,
): Effect.Effect<SignedMessageValue, RouterWorkerProtocolError> =>
  Effect.gen(function* () {
    const makeMessageId = runtime.input.overrides?.makeMessageId;
    const messageId = yield* makeMessageId === undefined
      ? makeRandomMessageId()
      : makeMessageId();
    const rewrapOverride = runtime.input.overrides?.rewrapOuter;
    const candidate = yield* rewrapOverride === undefined
      ? rewrapOuterDefault(runtime, signedMessage, messageId)
      : rewrapOverride({ signedMessage, messageId });
    return yield* validateRewrapped(signedMessage, candidate);
  });

interface TransmitInput {
  readonly message: SignedMessageValue;
  readonly instance: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly attemptsRemaining: number;
}

const retryUnknown = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
): Effect.Effect<
  RouterWorkerSendOutcome,
  RouterWorkerTransportError | RouterWorkerProtocolError
> => {
  if (input.mode !== "retry" || input.attemptsRemaining <= 1) {
    return Effect.fail(new RouterWorkerProtocolError());
  }
  return rewrapOuter(runtime, input.message).pipe(
    Effect.flatMap((message) =>
      // Retry identity loss re-enters the same bounded transport with the
      // replacement envelope and a strictly smaller attempt allowance.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- Mutual retry recursion is bounded by attemptsRemaining.
      transmitOuter(runtime, {
        message,
        instance: input.instance,
        mode: "initial",
        attemptsRemaining: input.attemptsRemaining - 1,
      }),
    ),
  );
};

const interpretSendResult = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
  result: RouterSendResult,
): Effect.Effect<
  RouterWorkerSendOutcome,
  RouterWorkerTransportError | RouterWorkerProtocolError
> => {
  if (result.kind === "accepted") {
    return result.routerInstanceId === input.instance
      ? Effect.succeed({ kind: "accepted" })
      : Effect.fail(new RouterWorkerProtocolError());
  }
  if (result.kind === "router_restarted") {
    return Effect.succeed({ kind: "restarted" });
  }
  return result.kind === "retry_identity_unknown"
    ? retryUnknown(runtime, input)
    : Effect.fail(new RouterWorkerProtocolError());
};

/**
 * Send one envelope with same-byte retry and one fresh-envelope recovery path.
 * @param runtime Worker capabilities, endpoint identity, and test seams.
 * @param input Exact envelope, Router fence, mode, and remaining attempts.
 * @returns Whether Router accepted the envelope or reported a restart.
 */
export const transmitOuter = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
): Effect.Effect<
  RouterWorkerSendOutcome,
  RouterWorkerTransportError | RouterWorkerProtocolError
> =>
  runtime.router
    .send({
      request: {
        expectedRouterInstanceId: input.instance,
        mode: input.mode,
        signedMessage: input.message,
      },
      callerAgentId: runtime.input.callerAgentId,
      signingAuthority: runtime.input.signingAuthority,
    })
    .pipe(
      Effect.mapError(mapTransportError),
      Effect.matchEffect({
        onFailure: (error) =>
          input.attemptsRemaining <= 1
            ? Effect.fail(error)
            : Effect.sleep(routerWorkerRetryDelay).pipe(
                Effect.zipRight(
                  transmitOuter(runtime, {
                    ...input,
                    mode: "retry",
                    attemptsRemaining: input.attemptsRemaining - 1,
                  }),
                ),
              ),
        onSuccess: (result) => interpretSendResult(runtime, input, result),
      }),
      Effect.interruptible,
    );
