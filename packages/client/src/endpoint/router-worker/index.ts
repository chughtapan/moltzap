/** @file Private Router polling, authenticated ingress, and retry coordination. */

import {
  AgentCard,
  type AgentId,
  MessageId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
  type VerifiedSignedMessage,
} from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import {
  Router,
  type RouterInstanceId,
  type RouterPollResult,
  type RouterSendResult,
  SignedMessageDigest,
} from "@moltzap/router";
import { Effect, Encoding, Fiber, Ref, Schedule, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import type { OutboundMessageInput, StoredOutboundMessage } from "../store.js";
import {
  decodeCanonical,
  type DecodedOuterBody,
  decodeOuterBody,
  encodeCanonical,
} from "../representation.js";
import {
  type RouterDiscontinuityReason,
  type RouterTailAnchor,
  type RouterWorker,
  type RouterWorkerActiveState,
  RouterWorkerAuthenticationError,
  RouterWorkerDiscontinuityError,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  RouterWorkerPersistenceError,
  type RouterWorkerPollError,
  RouterWorkerProtocolError,
  type RouterWorkerRecoveringState,
  type RouterWorkerRecoverySend,
  routerWorkerRetryAttempts,
  routerWorkerRetryDelay,
  type RouterWorkerRuntime,
  type RouterWorkerSendError,
  type RouterWorkerSendOutcome,
  type RouterWorkerServices,
  type RouterWorkerState,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
  type RouterWorkerVerifiedIngress,
} from "./types.js";

/** Router-worker errors used by endpoint composition. */
export {
  RouterWorkerAuthenticationError,
  RouterWorkerDiscontinuityError,
  RouterWorkerPayloadInvalidError,
  RouterWorkerPersistenceError,
  RouterWorkerProtocolError,
  RouterWorkerRecoveryError,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
} from "./types.js";
/** Router-worker protocol and capability types used by endpoint composition. */
export type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterTailAnchor,
  RouterWorker,
  RouterWorkerCallbacks,
  RouterWorkerIngress,
  RouterWorkerInput,
  RouterWorkerRecovery,
  RouterWorkerRecoverySend,
  RouterWorkerSendError,
} from "./types.js";

const mapAuthenticationError = () => new RouterWorkerAuthenticationError();
const mapTransportError = () => new RouterWorkerTransportError();
const mapProtocolError = () => new RouterWorkerProtocolError();
const mapPersistenceError = () => new RouterWorkerPersistenceError();

/** Bounded fixed-delay policy for poll-loop retries. */
const routerWorkerRetrySchedule = Schedule.fixed(routerWorkerRetryDelay).pipe(
  Schedule.intersect(Schedule.recurs(routerWorkerRetryAttempts - 1)),
);

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
const pollRouterTail = (
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
  readonly outbound: StoredOutboundMessage;
  readonly message: SignedMessageValue;
  readonly instance: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly attemptsRemaining: number;
}

type OutboundTransportError =
  | RouterWorkerPersistenceError
  | RouterWorkerTransportError
  | RouterWorkerProtocolError;

const retryUnknown = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
): Effect.Effect<RouterWorkerSendOutcome, OutboundTransportError> => {
  if (input.mode !== "retry" || input.attemptsRemaining <= 1) {
    return Effect.fail(new RouterWorkerProtocolError());
  }
  return Effect.gen(function* () {
    const message = yield* rewrapOuter(runtime, input.message);
    const canonicalSignedMessage = yield* encodeCanonical(
      SignedMessage,
      message,
    ).pipe(Effect.mapError(mapProtocolError));
    const replacement: OutboundMessageInput = {
      conversationId: input.outbound.conversationId,
      messageId: message.messageId,
      canonicalSignedMessage,
    };
    const outbound = yield* runtime.input.outbox
      .replaceOutbound(input.outbound, replacement)
      .pipe(Effect.mapError(mapPersistenceError));
    const attempt = yield* runtime.input.outbox
      .beginOutbound(outbound.outboundId)
      .pipe(Effect.mapError(mapPersistenceError));
    if (
      attempt.kind !== "pending" ||
      attempt.mode !== "initial" ||
      attempt.outbound.messageId !== outbound.messageId ||
      !bytesEqual(
        attempt.outbound.canonicalSignedMessage,
        outbound.canonicalSignedMessage,
      )
    ) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    return yield* transmitOuter(runtime, {
      outbound: attempt.outbound,
      message,
      instance: input.instance,
      mode: "initial",
      attemptsRemaining: input.attemptsRemaining - 1,
    });
  });
};

function digestCanonicalSignedMessage(
  canonicalSignedMessage: Uint8Array,
): Effect.Effect<typeof SignedMessageDigest.Type, RouterWorkerProtocolError> {
  return Effect.try({
    try: () => createHash("sha256").update(canonicalSignedMessage).digest(),
    catch: mapProtocolError,
  }).pipe(
    Effect.map((digest) => `smd_${Encoding.encodeBase64Url(digest)}`),
    Effect.flatMap(Schema.decodeUnknown(SignedMessageDigest)),
    Effect.mapError(mapProtocolError),
  );
}

function completeAcceptedOutbound<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
  result: Extract<RouterSendResult, { readonly kind: "accepted" }>,
): Effect.Effect<RouterWorkerSendOutcome, OutboundTransportError> {
  return Effect.gen(function* () {
    if (result.routerInstanceId !== input.instance) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const expectedDigest = yield* digestCanonicalSignedMessage(
      input.outbound.canonicalSignedMessage,
    );
    if (result.signedMessageDigest !== expectedDigest) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    yield* runtime.input.outbox
      .completeOutbound(input.outbound)
      .pipe(Effect.mapError(mapPersistenceError));
    return { kind: "accepted" };
  });
}

const interpretSendResult = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
  result: RouterSendResult,
): Effect.Effect<RouterWorkerSendOutcome, OutboundTransportError> => {
  switch (result.kind) {
    case "accepted":
      return completeAcceptedOutbound(runtime, input, result);
    case "router_restarted":
      return Effect.succeed({ kind: "restarted" });
    case "retry_identity_unknown":
      return retryUnknown(runtime, input);
    case "idempotency_conflict":
    case "message_invalid":
      return Effect.fail(new RouterWorkerProtocolError());
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

/**
 * Send one envelope with same-byte retry and one fresh-envelope recovery path.
 * @param runtime Worker capabilities, endpoint identity, and test seams.
 * @param input Exact envelope, Router fence, mode, and remaining attempts.
 * @returns Whether Router accepted the envelope or reported a restart.
 */
function transmitOuter<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: TransmitInput,
): Effect.Effect<RouterWorkerSendOutcome, OutboundTransportError> {
  return runtime.router
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
}

function decodeStoredOutbound(
  outbound: StoredOutboundMessage,
): Effect.Effect<SignedMessageValue, RouterWorkerProtocolError> {
  return decodeCanonical(SignedMessage, outbound.canonicalSignedMessage).pipe(
    Effect.mapError(mapProtocolError),
    Effect.flatMap((message) =>
      message.messageId === outbound.messageId
        ? Effect.succeed(message)
        : Effect.fail(new RouterWorkerProtocolError()),
    ),
  );
}

/**
 * Sends one durable current envelope selected by its stable outbox identity.
 *
 * @param runtime Worker capabilities and durable outbox.
 * @param outboundId Stable identity of the initial outer envelope.
 * @param instance Router instance fence for this attempt.
 * @returns Whether the stored envelope completed or observed a Router restart.
 */
function transmitOutbound<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  outboundId: string,
  instance: RouterInstanceId,
): Effect.Effect<RouterWorkerSendOutcome, OutboundTransportError> {
  return runtime.input.outbox.beginOutbound(outboundId).pipe(
    Effect.mapError(mapPersistenceError),
    Effect.flatMap((attempt) => {
      switch (attempt.kind) {
        case "inactive":
          return Effect.succeed({ kind: "accepted" } as const);
        case "pending":
          return decodeStoredOutbound(attempt.outbound).pipe(
            Effect.flatMap((message) =>
              message.senderAgentId === runtime.input.callerAgentId
                ? transmitOuter(runtime, {
                    outbound: attempt.outbound,
                    message,
                    instance,
                    mode: attempt.mode,
                    attemptsRemaining: routerWorkerRetryAttempts,
                  })
                : Effect.fail(new RouterWorkerProtocolError()),
            ),
          );
        default: {
          const exhaustive: never = attempt;
          return exhaustive;
        }
      }
    }),
  );
}

/**
 * Retains a recovery envelope before its first recovery-only Router attempt.
 *
 * @param runtime Worker capabilities and durable outbox.
 * @param input Conversation binding and complete signed recovery message.
 * @param instance Router instance fence for this attempt.
 * @returns Whether the retained envelope completed or observed a restart.
 */
function enqueueRecoveryOutbound<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: RouterWorkerRecoverySend,
  instance: RouterInstanceId,
): Effect.Effect<RouterWorkerSendOutcome, OutboundTransportError> {
  return Effect.gen(function* () {
    if (input.message.senderAgentId !== runtime.input.callerAgentId) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const canonicalSignedMessage = yield* encodeCanonical(
      SignedMessage,
      input.message,
    ).pipe(Effect.mapError(mapProtocolError));
    const outbound = yield* runtime.input.outbox
      .enqueueOutbound({
        conversationId: input.conversationId,
        messageId: input.message.messageId,
        canonicalSignedMessage,
      })
      .pipe(Effect.mapError(mapPersistenceError));
    return yield* transmitOutbound(runtime, outbound.outboundId, instance);
  });
}

type AnchoredRecoveringState = RouterWorkerRecoveringState & {
  readonly anchor: NonNullable<RouterWorkerRecoveringState["anchor"]>;
};

interface RecoveryOperations {
  readonly verifyBatch: (
    messages: readonly SignedMessageValue[],
  ) => Effect.Effect<
    readonly RouterWorkerVerifiedIngress[],
    RouterWorkerAuthenticationError | RouterWorkerPersistenceError
  >;
  readonly acceptRecovery: (
    ingress: RouterWorkerVerifiedIngress,
    routerInstanceId: RouterInstanceId,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

interface RecoveryBatch {
  readonly result: Extract<RouterPollResult, { readonly kind: "batch" }>;
  readonly verified: readonly RouterWorkerVerifiedIngress[];
}

const matchesRecovery = (
  state: RouterWorkerState,
  generation: number,
  routerInstanceId: RouterInstanceId,
): state is AnchoredRecoveringState =>
  state.kind === "recovering" &&
  state.generation === generation &&
  state.anchor?.routerInstanceId === routerInstanceId;

const snapshotRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  generation: number,
): Effect.Effect<AnchoredRecoveringState, RouterWorkerDiscontinuityError> =>
  Ref.get(runtime.state).pipe(
    Effect.flatMap((state) =>
      state.kind === "recovering" &&
      state.generation === generation &&
      state.anchor !== undefined
        ? Effect.succeed({ ...state, anchor: state.anchor })
        : Effect.fail(new RouterWorkerDiscontinuityError()),
    ),
  );

const commitRecoveryBatch = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  snapshot: AnchoredRecoveringState,
  batch: RecoveryBatch,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.stateGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        !matchesRecovery(
          current,
          snapshot.generation,
          batch.result.routerInstanceId,
        )
      ) {
        return;
      }
      yield* Effect.forEach(
        batch.verified,
        (ingress) =>
          operations.acceptRecovery(ingress, batch.result.routerInstanceId),
        { concurrency: 1 },
      );
      yield* Ref.set(runtime.state, {
        ...current,
        anchor: { ...current.anchor, pollCursor: batch.result.pollCursor },
      });
    }),
  );

const recoverySend = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  input: RouterWorkerRecoverySend,
): Effect.Effect<void, RouterWorkerSendError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(runtime.state);
    if (state.kind !== "recovering" || state.anchor === undefined) {
      return yield* Effect.fail(new RouterWorkerUnavailableError());
    }
    const outcome = yield* enqueueRecoveryOutbound(
      runtime,
      input,
      state.anchor.routerInstanceId,
    );
    if (outcome.kind === "restarted") {
      return yield* Effect.fail(new RouterWorkerDiscontinuityError());
    }
  });

const recoveryResume = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  outboundId: string,
): Effect.Effect<void, RouterWorkerSendError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(runtime.state);
    if (state.kind !== "recovering" || state.anchor === undefined) {
      return yield* Effect.fail(new RouterWorkerUnavailableError());
    }
    const outcome = yield* transmitOutbound(
      runtime,
      outboundId,
      state.anchor.routerInstanceId,
    );
    if (outcome.kind === "restarted") {
      return yield* Effect.fail(new RouterWorkerDiscontinuityError());
    }
  });

const pollRecoveringOnce = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  generation: number,
): Effect.Effect<void, RouterWorkerPollError> =>
  Effect.gen(function* () {
    const snapshot = yield* snapshotRecovery(runtime, generation);
    const result = yield* runtime.router
      .poll({
        request: { pollCursor: snapshot.anchor.pollCursor },
        callerAgentId: runtime.input.callerAgentId,
        signingAuthority: runtime.input.signingAuthority,
      })
      .pipe(Effect.mapError(mapTransportError));
    switch (result.kind) {
      case "batch": {
        if (result.routerInstanceId !== snapshot.anchor.routerInstanceId) {
          return yield* Effect.fail(new RouterWorkerDiscontinuityError());
        }
        const verified = yield* operations.verifyBatch(result.signedMessages);
        yield* commitRecoveryBatch(runtime, operations, snapshot, {
          result,
          verified,
        });
        return;
      }
      case "feed_gap":
      case "cursor_invalid":
        return yield* Effect.fail(new RouterWorkerDiscontinuityError());
      default:
        return yield* Effect.fail(new RouterWorkerProtocolError());
    }
  }).pipe(Effect.interruptible);

const pumpRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<never, RouterWorkerPollError> =>
  pollRecoveringOnce(runtime, operations, recovering.generation).pipe(
    Effect.retry(
      routerWorkerRetrySchedule.pipe(
        Schedule.whileInput(
          (error: RouterWorkerPollError) =>
            error._tag === "RouterWorkerTransportError",
        ),
      ),
    ),
    Effect.forever,
    Effect.interruptible,
  );

/**
 * Reconcile certified history while only recovery traffic advances the cursor.
 * @param runtime Worker runtime whose generation is being recovered.
 * @param operations Verification and persistence operations for recovery.
 * @param recovering Generation-scoped state to reconcile.
 * @returns An effect that completes after the worker becomes active.
 */
const finishRouterRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  operations: RecoveryOperations,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<void, RouterWorkerPollError> =>
  Effect.gen(function* () {
    const anchor = yield* pollRouterTail(runtime, runtime.input);
    const anchored = yield* anchorRecovery(runtime, recovering, anchor);
    const prepared = yield* prepareRecovery(runtime, anchored);
    yield* Effect.raceWith(
      runtime.input.callbacks.recoverCertifiedHistory({
        reason: prepared.reason,
        anchor: prepared.anchor,
        resume: (outboundId) => recoveryResume(runtime, outboundId),
        send: (message) => recoverySend(runtime, message),
      }),
      pumpRecovery(runtime, operations, prepared),
      {
        onSelfDone: (exit, pump) =>
          Fiber.interrupt(pump).pipe(Effect.zipRight(exit)),
        onOtherDone: (exit, recover) =>
          Fiber.interrupt(recover).pipe(Effect.zipRight(exit)),
      },
    );
    yield* runtime.stateGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(runtime.state);
        if (
          !matchesRecovery(
            current,
            prepared.generation,
            prepared.anchor.routerInstanceId,
          )
        ) {
          return yield* Effect.fail(new RouterWorkerDiscontinuityError());
        }
        yield* Ref.set(runtime.state, {
          kind: "active",
          generation: prepared.generation,
          anchor: current.anchor,
        });
      }),
    );
  }).pipe(Effect.withSpan("finishRouterRecovery"));

const seedPinnedCards = <Payload>(
  input: RouterWorkerInput<Payload>,
): Effect.Effect<Map<AgentId, VerifiedAgentCard>, RouterWorkerProtocolError> =>
  Effect.gen(function* () {
    const cards = new Map<AgentId, VerifiedAgentCard>();
    const representations = new Map<AgentId, string>();
    for (const card of input.pinnedSenderCards) {
      const representation = yield* Schema.encode(AgentCard)(card).pipe(
        Effect.map(JSON.stringify),
        Effect.catchTag("ParseError", () =>
          Effect.fail(new RouterWorkerProtocolError()),
        ),
      );
      const retained = representations.get(card.agentId);
      if (retained !== undefined && retained !== representation) {
        return yield* Effect.fail(new RouterWorkerProtocolError());
      }
      cards.set(card.agentId, card);
      representations.set(card.agentId, representation);
    }
    const local = representations.get(input.callerAgentId);
    const canonicalLocal = yield* Schema.encode(AgentCard)(
      input.callerAgentCard,
    ).pipe(
      Effect.map(JSON.stringify),
      Effect.catchTag("ParseError", () =>
        Effect.fail(new RouterWorkerProtocolError()),
      ),
    );
    if (local === undefined || local !== canonicalLocal) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    return cards;
  });

const verifyOuterDefault = (input: {
  readonly signedMessage: SignedMessageValue;
  readonly agentCard: VerifiedAgentCard;
}): Effect.Effect<VerifiedSignedMessage, RouterWorkerAuthenticationError> =>
  SignedMessage.verify(input).pipe(Effect.mapError(mapAuthenticationError));

const decodePayloadDefault = (
  message: VerifiedSignedMessage,
): Effect.Effect<DecodedOuterBody, RouterWorkerPayloadInvalidError> =>
  decodeOuterBody(message.body).pipe(
    Effect.catchTag("ClientRepresentationError", () =>
      Effect.fail(new RouterWorkerPayloadInvalidError()),
    ),
  );

const resolveSenderCard = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  agentId: AgentId,
): Effect.Effect<
  VerifiedAgentCard,
  RouterWorkerAuthenticationError | RouterWorkerPersistenceError
> => {
  const cached = runtime.cards.get(agentId);
  if (cached !== undefined) {
    return Effect.succeed(cached);
  }
  return runtime.registry.lookup({ agentId }).pipe(
    Effect.mapError(mapAuthenticationError),
    Effect.flatMap((result) =>
      result.kind === "found" && result.agentCard.agentId === agentId
        ? Effect.succeed(result.agentCard)
        : Effect.fail(new RouterWorkerAuthenticationError()),
    ),
    Effect.tap(runtime.input.callbacks.pinSenderCard),
    Effect.tap((card) => Effect.sync(() => runtime.cards.set(agentId, card))),
    Effect.interruptible,
  );
};

const verifyOuter = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  signedMessage: SignedMessageValue,
): Effect.Effect<
  RouterWorkerVerifiedIngress,
  RouterWorkerAuthenticationError | RouterWorkerPersistenceError
> =>
  Effect.gen(function* () {
    const senderCard = yield* resolveSenderCard(
      runtime,
      signedMessage.senderAgentId,
    );
    const verify = runtime.input.overrides?.verifyOuter ?? verifyOuterDefault;
    const message = yield* verify({ signedMessage, agentCard: senderCard });
    return { message, senderCard };
  });

const verifyBatch = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  messages: readonly SignedMessageValue[],
): Effect.Effect<
  readonly RouterWorkerVerifiedIngress[],
  RouterWorkerAuthenticationError | RouterWorkerPersistenceError
> =>
  Effect.forEach(messages, (message) => verifyOuter(runtime, message), {
    concurrency: 1,
  });

const decodePayload = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  message: VerifiedSignedMessage,
): Effect.Effect<Payload, RouterWorkerPayloadInvalidError> => {
  const configured = runtime.input.callbacks.decodePayload;
  if (configured !== undefined) {
    return configured(message);
  }
  // RouterWorkerInput defaults Payload to DecodedOuterBody, so absence of a
  // custom decoder and this cast are introduced by the same generic default.
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- Generic default and decoder default are the same DecodedOuterBody type.
  return decodePayloadDefault(message) as Effect.Effect<
    Payload,
    RouterWorkerPayloadInvalidError
  >;
};

const acceptVerified = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  ingress: RouterWorkerVerifiedIngress,
  routerInstanceId: RouterInstanceId,
  phase: "active" | "recovering" = "active",
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  decodePayload(runtime, ingress.message).pipe(
    Effect.flatMap((payload) =>
      phase === "active"
        ? runtime.input.callbacks.acceptPayload({
            ...ingress,
            payload,
            routerInstanceId,
          })
        : runtime.input.callbacks.acceptRecoveryPayload({
            ...ingress,
            payload,
            routerInstanceId,
          }),
    ),
    Effect.asVoid,
    Effect.catchTag("RouterWorkerPayloadInvalidError", () => Effect.void),
  );

const stateMatches = (
  state: RouterWorkerState,
  generation: number,
  routerInstanceId: RouterInstanceId,
): state is RouterWorkerActiveState =>
  state.kind === "active" &&
  state.generation === generation &&
  state.anchor.routerInstanceId === routerInstanceId;

const commitBatch = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerActiveState,
  result: Extract<RouterPollResult, { readonly kind: "batch" }>,
  verified: readonly RouterWorkerVerifiedIngress[],
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  runtime.stateGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        !stateMatches(current, snapshot.generation, result.routerInstanceId)
      ) {
        return;
      }
      // Accept callbacks are durable state transitions. Network consequences
      // are queued for the worker after this ordered batch commit.
      yield* Effect.forEach(
        verified,
        (ingress) => acceptVerified(runtime, ingress, result.routerInstanceId),
        { concurrency: 1 },
      );
      yield* Ref.set(runtime.state, {
        ...current,
        anchor: { ...current.anchor, pollCursor: result.pollCursor },
      });
    }),
  );

function prepareRecovery<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: AnchoredRecoveringState,
): Effect.Effect<AnchoredRecoveringState, RouterWorkerPollError> {
  if (recovering.volatileFoldsAbandoned) {
    return Effect.succeed(recovering);
  }
  return runtime.input.callbacks.abandonVolatileFolds(recovering.reason).pipe(
    Effect.zipRight(
      runtime.stateGate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(runtime.state);
          if (
            current.kind !== "recovering" ||
            current.generation !== recovering.generation ||
            current.anchor === undefined
          ) {
            return yield* Effect.fail(new RouterWorkerDiscontinuityError());
          }
          const prepared: AnchoredRecoveringState = {
            ...current,
            anchor: current.anchor,
            volatileFoldsAbandoned: true,
          };
          yield* Ref.set(runtime.state, prepared);
          return prepared;
        }),
      ),
    ),
  );
}

function anchorRecovery<Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: RouterWorkerRecoveringState,
  anchor: RouterTailAnchor,
): Effect.Effect<AnchoredRecoveringState, RouterWorkerPollError> {
  return runtime.stateGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        current.kind !== "recovering" ||
        current.generation !== recovering.generation
      ) {
        return yield* Effect.fail(new RouterWorkerDiscontinuityError());
      }
      const reason =
        current.priorRouterInstanceId !== undefined &&
        current.priorRouterInstanceId !== anchor.routerInstanceId
          ? "router_restarted"
          : current.reason;
      const anchored: AnchoredRecoveringState = {
        ...current,
        reason,
        priorRouterInstanceId:
          current.priorRouterInstanceId ?? anchor.routerInstanceId,
        volatileFoldsAbandoned:
          current.reason === reason && current.volatileFoldsAbandoned,
        anchor,
      };
      yield* Ref.set(runtime.state, anchored);
      return anchored;
    }),
  );
}

const finishRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<void, RouterWorkerPollError> =>
  finishRouterRecovery(
    runtime,
    {
      verifyBatch: (messages) => verifyBatch(runtime, messages),
      acceptRecovery: (ingress, routerInstanceId) =>
        acceptVerified(runtime, ingress, routerInstanceId, "recovering"),
    },
    recovering,
  );

const triggerDiscontinuity = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  reason: RouterDiscontinuityReason,
  observedGeneration: number,
): Effect.Effect<void, RouterWorkerPollError> =>
  runtime.recoveryGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runtime.state);
      if (
        current.kind === "active" &&
        current.generation !== observedGeneration
      ) {
        return;
      }
      if (current.kind === "recovering") {
        return yield* finishRecovery(runtime, current);
      }
      const recovering: RouterWorkerRecoveringState = {
        kind: "recovering",
        generation: current.generation + 1,
        reason,
        priorRouterInstanceId: current.anchor.routerInstanceId,
        volatileFoldsAbandoned: false,
      };
      yield* runtime.stateGate.withPermits(1)(
        Ref.set(runtime.state, recovering),
      );
      return yield* finishRecovery(runtime, recovering);
    }),
  );

const pollActiveOnce = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  snapshot: RouterWorkerActiveState,
): Effect.Effect<void, RouterWorkerPollError> =>
  runtime.router
    .poll({
      request: { pollCursor: snapshot.anchor.pollCursor },
      callerAgentId: runtime.input.callerAgentId,
      signingAuthority: runtime.input.signingAuthority,
    })
    .pipe(
      Effect.mapError(mapTransportError),
      Effect.flatMap((result) => {
        switch (result.kind) {
          case "batch":
            if (result.routerInstanceId !== snapshot.anchor.routerInstanceId) {
              return triggerDiscontinuity(
                runtime,
                "router_restarted",
                snapshot.generation,
              );
            }
            return verifyBatch(runtime, result.signedMessages).pipe(
              Effect.flatMap((verified) =>
                commitBatch(runtime, snapshot, result, verified),
              ),
            );
          case "feed_gap":
            return triggerDiscontinuity(
              runtime,
              "feed_gap",
              snapshot.generation,
            );
          case "cursor_invalid":
            return triggerDiscontinuity(
              runtime,
              "cursor_invalid",
              snapshot.generation,
            );
          default:
            return Effect.fail(new RouterWorkerProtocolError());
        }
      }),
      Effect.interruptible,
    );

const makePollOnce = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
): Effect.Effect<void, RouterWorkerPollError> =>
  runtime.pollGate.withPermits(1)(
    Ref.get(runtime.state).pipe(
      Effect.flatMap((state) =>
        state.kind === "active"
          ? pollActiveOnce(runtime, state)
          : runtime.recoveryGate.withPermits(1)(finishRecovery(runtime, state)),
      ),
    ),
  );

const makeSend = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  outboundId: string,
): Effect.Effect<void, RouterWorkerSendError> =>
  Effect.gen(function* () {
    const result = yield* runtime.recoveryGate.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(runtime.state);
        if (state.kind !== "active") {
          return yield* Effect.fail(new RouterWorkerUnavailableError());
        }
        const outcome = yield* transmitOutbound(
          runtime,
          outboundId,
          state.anchor.routerInstanceId,
        );
        return { outcome, generation: state.generation };
      }),
    );
    if (result.outcome.kind === "restarted") {
      yield* triggerDiscontinuity(
        runtime,
        "router_restarted",
        result.generation,
      );
      return yield* Effect.fail(new RouterWorkerDiscontinuityError());
    }
  });

const makeWorker = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
): RouterWorker => {
  const pollOnce = makePollOnce(runtime);
  return Object.freeze({
    currentAnchor: Ref.get(runtime.state).pipe(
      Effect.flatMap((state) =>
        state.kind === "active"
          ? Effect.succeed(state.anchor)
          : Effect.fail(new RouterWorkerUnavailableError()),
      ),
    ),
    pollOnce,
    run: pollOnce.pipe(
      Effect.retry(routerWorkerRetrySchedule),
      Effect.forever,
      Effect.interruptible,
    ),
    send: (outboundId: string) => makeSend(runtime, outboundId),
  });
};

/**
 * Build a recovering worker without starting its polling loop.
 * @param input Registered identity and durable endpoint callbacks.
 * @returns A worker that remains unavailable until certified recovery completes.
 */
export const makeRouterWorker = <Payload>(
  input: RouterWorkerInput<Payload>,
): Effect.Effect<
  RouterWorker,
  RouterWorkerTransportError | RouterWorkerProtocolError,
  Registry | Router
> =>
  Effect.gen(function* () {
    if (input.callerAgentCard.agentId !== input.callerAgentId) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const services = {
      router: yield* Router,
      registry: yield* Registry,
    };
    const cards = yield* seedPinnedCards(input);
    const runtime: RouterWorkerRuntime<Payload> = {
      ...services,
      input,
      cards,
      state: yield* Ref.make<RouterWorkerState>({
        kind: "recovering",
        generation: 0,
        reason: "router_restarted",
        volatileFoldsAbandoned: false,
      }),
      pollGate: yield* Effect.makeSemaphore(1),
      stateGate: yield* Effect.makeSemaphore(1),
      recoveryGate: yield* Effect.makeSemaphore(1),
    };
    return makeWorker(runtime);
  }).pipe(Effect.withSpan("makeRouterWorker"));
