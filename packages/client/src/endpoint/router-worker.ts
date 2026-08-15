/** @file Private Router polling, authenticated ingress, and retry coordination. */

import {
  AgentCard,
  type AgentId,
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
} from "@moltzap/router";
import { Effect, Ref, Schema, type Scope } from "effect";
import { type DecodedOuterBody, decodeOuterBody } from "./representation.js";
import { finishRouterRecovery } from "./router-worker-recovery.js";
import {
  pollRouterTail,
  routerWorkerRetrySchedule,
  transmitOuter,
} from "./router-worker-transport.js";
import {
  type RouterDiscontinuityReason,
  type RouterWorker,
  type RouterWorkerActiveState,
  RouterWorkerAuthenticationError,
  RouterWorkerDiscontinuityError,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  type RouterWorkerPersistenceError,
  type RouterWorkerPollError,
  RouterWorkerProtocolError,
  type RouterWorkerRecoveringState,
  routerWorkerRetryAttempts,
  type RouterWorkerRuntime,
  type RouterWorkerSendError,
  type RouterWorkerState,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
  type RouterWorkerVerifiedIngress,
} from "./router-worker-types.js";

/** Router-worker errors and retry constants used by endpoint composition. */
export {
  RouterWorkerAuthenticationError,
  RouterWorkerDiscontinuityError,
  RouterWorkerPayloadInvalidError,
  RouterWorkerPersistenceError,
  RouterWorkerProtocolError,
  RouterWorkerRecoveryError,
  routerWorkerRetryAttempts,
  routerWorkerRetryDelay,
  RouterWorkerTransportError,
  RouterWorkerUnavailableError,
} from "./router-worker-types.js";
/** Router-worker protocol and capability types used by endpoint composition. */
export type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterTailAnchor,
  RouterWorker,
  RouterWorkerActiveState,
  RouterWorkerCallbacks,
  RouterWorkerIngress,
  RouterWorkerInput,
  RouterWorkerOverrides,
  RouterWorkerPollError,
  RouterWorkerRecoveringState,
  RouterWorkerRecovery,
  RouterWorkerRuntime,
  RouterWorkerSendError,
  RouterWorkerSendOutcome,
  RouterWorkerServices,
  RouterWorkerState,
  RouterWorkerVerifiedIngress,
} from "./router-worker-types.js";

const mapAuthenticationError = () => new RouterWorkerAuthenticationError();
const mapTransportError = () => new RouterWorkerTransportError();

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
  phase: "active" | "recovering" = "active",
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  decodePayload(runtime, ingress.message).pipe(
    Effect.flatMap((payload) =>
      phase === "active"
        ? runtime.input.callbacks.acceptPayload({ ...ingress, payload })
        : runtime.input.callbacks.acceptRecoveryPayload({
            ...ingress,
            payload,
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
        (ingress) => acceptVerified(runtime, ingress),
        { concurrency: 1 },
      );
      yield* Ref.set(runtime.state, {
        ...current,
        anchor: { ...current.anchor, pollCursor: result.pollCursor },
      });
    }),
  );

const finishRecovery = <Payload>(
  runtime: RouterWorkerRuntime<Payload>,
  recovering: RouterWorkerRecoveringState,
): Effect.Effect<void, RouterWorkerPollError> =>
  finishRouterRecovery(
    runtime,
    {
      verifyBatch: (messages) => verifyBatch(runtime, messages),
      acceptRecovery: (ingress) =>
        acceptVerified(runtime, ingress, "recovering"),
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
      };
      yield* runtime.stateGate.withPermits(1)(
        Ref.set(runtime.state, recovering),
      );
      yield* runtime.input.callbacks.abandonVolatileFolds(reason);
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
  message: SignedMessageValue,
): Effect.Effect<void, RouterWorkerSendError> =>
  Effect.gen(function* () {
    const state = yield* Ref.get(runtime.state);
    if (state.kind !== "active") {
      return yield* Effect.fail(new RouterWorkerUnavailableError());
    }
    if (message.senderAgentId !== runtime.input.callerAgentId) {
      return yield* Effect.fail(new RouterWorkerProtocolError());
    }
    const outcome = yield* transmitOuter(runtime, {
      message,
      instance: state.anchor.routerInstanceId,
      mode: "initial",
      attemptsRemaining: routerWorkerRetryAttempts,
    });
    if (outcome.kind === "restarted") {
      yield* triggerDiscontinuity(
        runtime,
        "router_restarted",
        state.generation,
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
    send: (message: SignedMessageValue) => makeSend(runtime, message),
  });
};

/**
 * Build an anchored worker without starting its polling loop.
 * @param input Registered identity and durable endpoint callbacks.
 * @returns A worker whose initial cursor is an immediate empty Router tail.
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
    const anchor = yield* pollRouterTail(services, input);
    const cards = yield* seedPinnedCards(input);
    const runtime: RouterWorkerRuntime<Payload> = {
      ...services,
      input,
      cards,
      state: yield* Ref.make<RouterWorkerState>({
        kind: "active",
        generation: 0,
        anchor,
      }),
      pollGate: yield* Effect.makeSemaphore(1),
      stateGate: yield* Effect.makeSemaphore(1),
      recoveryGate: yield* Effect.makeSemaphore(1),
    };
    return makeWorker(runtime);
  }).pipe(Effect.withSpan("makeRouterWorker"));

/**
 * Acquire an anchored worker and bind its polling fiber to the caller's scope.
 * @param input Registered identity and durable endpoint callbacks.
 * @returns The running worker; closing the scope interrupts its bounded loop.
 */
export const acquireRouterWorker = <Payload>(
  input: RouterWorkerInput<Payload>,
): Effect.Effect<
  RouterWorker,
  RouterWorkerTransportError | RouterWorkerProtocolError,
  Registry | Router | Scope.Scope
> =>
  makeRouterWorker(input).pipe(
    Effect.tap((worker) => Effect.forkScoped(worker.run).pipe(Effect.asVoid)),
  );
