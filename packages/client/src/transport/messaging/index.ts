/** @file Private addressed-message engine acquisition and daemon seams. */

import { AgentCard, AgentSigningAuthority } from "@moltzap/identity";
import {
  Deferred,
  Duration,
  Effect,
  Queue,
  Schedule,
  Schema,
  type Scope,
  SubscriptionRef,
} from "effect";
import type { DeliveryToken, EndpointStoreError } from "../../store/index.js";
import {
  describeRouterWorkerFailure,
  isTransientRouterWorkerError,
  type RouterDiscontinuityReason,
  routerWorkerReconnectSchedule,
  type RouterWorkerSendError,
} from "../router/index.js";
import {
  type ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  PostIntent,
  RecordHash,
} from "../wire/index.js";
import { resumeEngineFolds } from "./certification.js";
import { resumeDisseminationObligations } from "./dissemination.js";
import { DeliveryAcknowledgeError, ListenError, SendError } from "./errors.js";
import { InboundMessage } from "./message.js";
import { installRecoveryBarrier } from "./recovery/barrier.js";
import {
  acceptEngineIngressWithRecovery,
  acceptEngineRecoveryIngressWithRecovery,
  recoverCertifiedHistory,
  recoverEngineState,
} from "./recovery/index.js";
import { prepareSend, proposeIntent, resolveAddress } from "./send.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  EngineInitializationError,
  EngineOutboundError,
  type EnginePendingMessage,
  type EngineRuntime,
  type EngineSendInput,
  type EngineSentPost,
} from "./types.js";

type RecoveredStateError = Effect.Effect.Error<
  ReturnType<typeof recoverEngineState>
>;

/** Closed engine errors used by daemon composition. */
export { EngineInitializationError, EngineOutboundError } from "./types.js";
/** Private engine contracts retained behind the daemon boundary. */
export type {
  EndpointEngine,
  EndpointEngineInput,
  EnginePendingMessage,
  EngineSendInput,
  EngineSentPost,
} from "./types.js";

const initializationReasonByStoreReason = {
  closed: "persistence",
  conflict: "identity",
  corrupt: "persistence",
  incompatible: "persistence",
  "invalid-continuation": "persistence",
  "invalid-input": "persistence",
  "not-found": "persistence",
  persistence: "persistence",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], EngineInitializationError["reason"]>
>;

const listenReasonByStoreReason = {
  closed: "transport-failed",
  conflict: "decode-failed",
  corrupt: "decode-failed",
  incompatible: "incompatible-daemon",
  "invalid-continuation": "decode-failed",
  "invalid-input": "decode-failed",
  "not-found": "decode-failed",
  persistence: "transport-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], ListenError["reason"]>
>;

const acknowledgeReasonByStoreReason = {
  closed: "persistence-failed",
  conflict: "delivery-conflict",
  corrupt: "persistence-failed",
  incompatible: "persistence-failed",
  "invalid-continuation": "persistence-failed",
  "invalid-input": "persistence-failed",
  "not-found": "unknown-delivery",
  persistence: "persistence-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], DeliveryAcknowledgeError["reason"]>
>;

type ResumeIntentDisposition =
  | "fail-persistence"
  | "fail-representation"
  | "ignore";

const resumeDispositionBySendReason = {
  "idempotency-conflict": "fail-representation",
  "outcome-unknown": "fail-representation",
  "certification-unavailable": "ignore",
  "content-invalid": "fail-representation",
  "invalid-address": "fail-representation",
  "membership-invalid": "fail-representation",
  "network-unavailable": "ignore",
  "not-registered": "fail-representation",
  "persistence-failed": "fail-persistence",
  "unknown-agent": "fail-representation",
  "version-mismatch": "fail-representation",
} as const satisfies Readonly<
  Record<SendError["reason"], ResumeIntentDisposition>
>;

const outboundReasonByTag = {
  RouterWorkerAuthenticationError: "representation",
  RouterWorkerDiscontinuityError: "network",
  RouterWorkerPersistenceError: "persistence",
  RouterWorkerProtocolError: "representation",
  RouterWorkerRecoveryError: "network",
  RouterWorkerTransportError: "network",
  RouterWorkerUnavailableError: "network",
} as const satisfies Readonly<
  Record<
    Exclude<RouterWorkerSendError["_tag"], "RouterWorkerRejectedError">,
    EngineOutboundError["reason"]
  >
>;

const outboundFailure = (error: RouterWorkerSendError): EngineOutboundError => {
  if (error._tag !== "RouterWorkerRejectedError") {
    return new EngineOutboundError({ reason: outboundReasonByTag[error._tag] });
  }
  return new EngineOutboundError({
    reason: error.reason === "version" ? "version" : "representation",
  });
};

function outboundSendFailure(error: EngineOutboundError): SendError {
  switch (error.reason) {
    case "persistence":
      return new SendError({ reason: "persistence-failed" });
    case "network":
      return new SendError({ reason: "network-unavailable" });
    case "representation":
      return new SendError({ reason: "certification-unavailable" });
    case "version":
      return new SendError({ reason: "version-mismatch" });
    default: {
      const exhaustive: never = error.reason;
      return exhaustive;
    }
  }
}

function listenStoreFailure(error: EndpointStoreError): ListenError {
  return new ListenError({ reason: listenReasonByStoreReason[error.reason] });
}

function listenRepresentationFailure(): ListenError {
  return new ListenError({ reason: "decode-failed" });
}

function acknowledgeStoreFailure(
  error: EndpointStoreError,
): DeliveryAcknowledgeError {
  return new DeliveryAcknowledgeError({
    reason: acknowledgeReasonByStoreReason[error.reason],
  });
}

function bindIdentityFailure(
  error: ClientRepresentationError | EndpointStoreError,
): EngineInitializationError {
  switch (error._tag) {
    case "ClientRepresentationError":
      return representationInitializationFailure();
    case "EndpointStoreError":
      return initializationStoreFailure(error);
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function recoveryInitializationFailure(
  error: RecoveredStateError,
): EngineInitializationError {
  switch (error._tag) {
    case "ClientRepresentationError":
    case "ParseError":
      return representationInitializationFailure();
    case "RouterWorkerPersistenceError":
      return new EngineInitializationError({ reason: "persistence" });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function resumeIntentFailure(
  error: SendError,
): Effect.Effect<void, EngineInitializationError> {
  const disposition = resumeDispositionBySendReason[error.reason];
  switch (disposition) {
    case "fail-persistence":
      return Effect.fail(
        new EngineInitializationError({ reason: "persistence" }),
      );
    case "fail-representation":
      return Effect.fail(representationInitializationFailure());
    case "ignore":
      return Effect.void;
    default: {
      const exhaustive: never = disposition;
      return exhaustive;
    }
  }
}

function initializationStoreFailure(
  error: EndpointStoreError,
): EngineInitializationError {
  return new EngineInitializationError({
    reason: initializationReasonByStoreReason[error.reason],
  });
}

function representationInitializationFailure(): EngineInitializationError {
  return new EngineInitializationError({ reason: "representation" });
}

function resumeFoldFailure(): EngineInitializationError {
  return new EngineInitializationError({ reason: "persistence" });
}

/**
 * How long a local send's own drain may run before the send fails as
 * `network-unavailable`. With `ROUTER_ATTACH_TIMEOUT` it stays under the MCP
 * SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`. The envelope stays queued, so the
 * background drain still delivers it once the Router answers.
 */
const LOCAL_DRAIN_TIMEOUT = Duration.seconds(10);

const peekOutbound = (
  runtime: EngineRuntime,
): Effect.Effect<string | undefined> =>
  runtime.outboundGate.withPermits(1)(Effect.sync(() => runtime.outbound[0]));

const shiftOutbound = (
  runtime: EngineRuntime,
  outboundId: string,
): Effect.Effect<void> =>
  runtime.outboundGate.withPermits(1)(
    Effect.sync(() => {
      if (runtime.outbound[0] === outboundId) {
        runtime.outbound.shift();
      }
    }),
  );

/**
 * Send queued outbox identities in order until the queue is empty.
 *
 * The outbound gate covers only reading and removing the queue head, never the
 * worker send. A worker send queues behind a running recovery on the worker's
 * recovery gate, and may run that recovery on its own fiber after it observes
 * a Router restart; recovery takes the outbound gate to resume intents, so
 * holding the gate across the send would deadlock either way. The worker
 * serializes transmissions and a sent outbox identity is inactive, so
 * concurrent drains stay ordered; a drain removes the head only when it is
 * still the identity that drain sent.
 * @param runtime Engine whose queued outbox identities are sent.
 * @returns Completion once no queued identity remains.
 */
const drainOutbound = (
  runtime: EngineRuntime,
): Effect.Effect<void, RouterWorkerSendError> =>
  Effect.gen(function* () {
    let outboundId = yield* peekOutbound(runtime);
    while (outboundId !== undefined) {
      yield* runtime.input.routerWorker.send(outboundId);
      yield* shiftOutbound(runtime, outboundId);
      outboundId = yield* peekOutbound(runtime);
    }
  });

const send = (
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<EngineSentPost, SendError> =>
  Effect.gen(function* () {
    const prepared = yield* prepareSend(runtime, input);
    yield* drainOutbound(runtime).pipe(
      Effect.mapError((error) => outboundSendFailure(outboundFailure(error))),
      Effect.timeoutFail({
        duration: LOCAL_DRAIN_TIMEOUT,
        onTimeout: () => new SendError({ reason: "network-unavailable" }),
      }),
    );
    const recordHash = yield* Deferred.await(prepared.completion);
    return { postId: prepared.postId, recordHash };
  }).pipe(Effect.withSpan("EndpointEngine.send"));

/**
 * Drain once the worker is attached, and after a transient worker failure
 * back off, wait for the worker to re-anchor, and drain again. Recovery may
 * have reset the queue meanwhile, so each attempt re-reads its head. A fatal
 * failure is logged with its reason before it ends the daemon.
 * @param runtime The engine whose outbound queue the worker drains.
 * @returns An effect that drains until a fatal worker failure.
 */
const drainWhenAttached = (
  runtime: EngineRuntime,
): Effect.Effect<void, EngineOutboundError> =>
  runtime.input.routerWorker.awaitAnchor.pipe(
    Effect.zipRight(drainOutbound(runtime)),
    Effect.retry(
      routerWorkerReconnectSchedule.pipe(
        Schedule.whileInput(isTransientRouterWorkerError),
      ),
    ),
    Effect.tapError((error) =>
      Effect.logError(
        `Outbound drain stopping, daemon exits: ${describeRouterWorkerFailure(error)}`,
      ),
    ),
    Effect.mapError(outboundFailure),
  );

const runOutbound = (
  runtime: EngineRuntime,
): Effect.Effect<never, EngineOutboundError> =>
  Queue.take(runtime.outboundSignal).pipe(
    Effect.zipRight(drainWhenAttached(runtime)),
    Effect.forever,
  );

const readPendingMessages = (
  runtime: EngineRuntime,
): Effect.Effect<readonly EnginePendingMessage[], ListenError> =>
  runtime.input.store.readPendingDeliveries().pipe(
    Effect.mapError(listenStoreFailure),
    Effect.flatMap((deliveries) =>
      Effect.forEach(
        deliveries,
        (delivery) =>
          Effect.all({
            message: decodeCanonical(InboundMessage, delivery.canonicalMessage),
            recordHash: Schema.decodeUnknown(RecordHash)(delivery.recordHash),
          }).pipe(
            Effect.mapError(listenRepresentationFailure),
            Effect.map(({ message, recordHash }) => ({
              deliveryToken: delivery.deliveryToken,
              recordHash,
              message,
            })),
          ),
        { concurrency: 1 },
      ),
    ),
  );

const acknowledgeMessage = (
  runtime: EngineRuntime,
  deliveryToken: DeliveryToken,
): Effect.Effect<void, DeliveryAcknowledgeError> =>
  runtime.input.store
    .acknowledgeDelivery(deliveryToken)
    .pipe(Effect.mapError(acknowledgeStoreFailure), Effect.asVoid);

const validateLocalIdentity = (
  input: EndpointEngineInput,
): Effect.Effect<void, EngineInitializationError> =>
  AgentSigningAuthority.publicKey(input.signingAuthority).x ===
  input.localAgentCard.publicKey.x
    ? Effect.void
    : Effect.fail(new EngineInitializationError({ reason: "identity" }));

const bindLocalIdentity = (
  input: EndpointEngineInput,
): Effect.Effect<void, EngineInitializationError> =>
  encodeCanonical(AgentCard, input.localAgentCard).pipe(
    Effect.flatMap((canonicalAgentCard) =>
      input.store.bindIdentity({
        agentId: input.localAgentCard.agentId,
        canonicalAgentCard,
      }),
    ),
    Effect.mapError(bindIdentityFailure),
  );

const makeRuntime = (
  input: EndpointEngineInput,
  recovered: Effect.Effect.Success<ReturnType<typeof recoverEngineState>>,
): Effect.Effect<EngineRuntime> =>
  Effect.gen(function* () {
    const outbound = recovered.outboundMessages.map(
      (message) => message.outboundId,
    );
    const outboundSignal = yield* Queue.unbounded<undefined>();
    if (outbound.length > 0) {
      yield* Queue.offer(outboundSignal, undefined);
    }
    return {
      input,
      conversations: recovered.conversations,
      intents: new Map(),
      completedPosts: recovered.completedPosts,
      actionFolds: recovered.actionFolds,
      recordFolds: recovered.recordFolds,
      outbound,
      outboundSignal,
      gate: yield* Effect.makeSemaphore(1),
      outboundGate: yield* Effect.makeSemaphore(1),
      revision: yield* SubscriptionRef.make(0),
    };
  });

const hydratePostIntents = (
  runtime: EngineRuntime,
  postIntents: Effect.Effect.Success<
    ReturnType<typeof recoverEngineState>
  >["postIntents"],
): Effect.Effect<void, EngineInitializationError> =>
  Effect.forEach(
    postIntents,
    (stored) =>
      Effect.gen(function* () {
        const intent = yield* decodeCanonical(
          PostIntent,
          stored.canonicalIntent,
        ).pipe(Effect.mapError(representationInitializationFailure));
        const completion = yield* Deferred.make<RecordHash, SendError>();
        yield* Effect.sync(() => {
          runtime.intents.set(intent.postId, {
            intent,
            canonicalIntent: stored.canonicalIntent,
            completion,
          });
        });
        const completedRecordHash = runtime.completedPosts.get(intent.postId);
        if (completedRecordHash !== undefined) {
          yield* Deferred.succeed(completion, completedRecordHash);
        }
      }),
    { concurrency: 1, discard: true },
  );

const initializeRuntime = (
  input: EndpointEngineInput,
): Effect.Effect<EngineRuntime, EngineInitializationError> =>
  Effect.gen(function* () {
    yield* validateLocalIdentity(input);
    yield* bindLocalIdentity(input);
    const recovery = yield* input.store
      .recover()
      .pipe(Effect.mapError(initializationStoreFailure));
    const recovered = yield* recoverEngineState(input, recovery).pipe(
      Effect.mapError(recoveryInitializationFailure),
    );
    const runtime = yield* makeRuntime(input, recovered);
    yield* hydratePostIntents(runtime, recovered.postIntents);
    return runtime;
  });

const resumeRuntime = (runtime: EngineRuntime) =>
  Effect.gen(function* () {
    yield* resumeDisseminationObligations(runtime).pipe(
      Effect.mapError(resumeFoldFailure),
    );
    yield* resumeEngineFolds(runtime).pipe(Effect.mapError(resumeFoldFailure));
    yield* Effect.forEach(
      runtime.intents.values(),
      (intent) =>
        runtime.completedPosts.has(intent.intent.postId)
          ? Effect.void
          : proposeIntent(runtime, intent).pipe(
              Effect.asVoid,
              Effect.catchTag("SendError", resumeIntentFailure),
            ),
      { concurrency: 1, discard: true },
    );
  });

const abandonVolatileFolds = (
  runtime: EngineRuntime,
  reason: RouterDiscontinuityReason,
): Effect.Effect<void> =>
  runtime.gate
    .withPermits(1)(
      Effect.gen(function* () {
        yield* installRecoveryBarrier(runtime);
        yield* Effect.sync(() => {
          runtime.outbound.length = 0;
          if (reason !== "router_restarted") {
            return;
          }
          for (const fold of runtime.actionFolds.values()) {
            fold.localActionEvidenceQueued = false;
            fold.actionCertifiedRecordQueued = false;
            fold.localDurabilityEvidenceQueued = false;
            fold.certifiedRecordQueued = false;
          }
        });
      }),
    )
    .pipe(Effect.withSpan("abandonVolatileFolds", { attributes: { reason } }));

const endpointEngine = (runtime: EngineRuntime): EndpointEngine =>
  Object.freeze({
    send: (sendInput: Parameters<EndpointEngine["send"]>[0]) =>
      send(runtime, sendInput),
    resolveAddress: (to: Parameters<EndpointEngine["resolveAddress"]>[0]) =>
      resolveAddress(runtime, to),
    readPendingMessages: () => readPendingMessages(runtime),
    acknowledgeMessage: (
      deliveryToken: Parameters<EndpointEngine["acknowledgeMessage"]>[0],
    ) => acknowledgeMessage(runtime, deliveryToken),
    acceptRouterIngress: (
      ingress: Parameters<EndpointEngine["acceptRouterIngress"]>[0],
    ) => acceptEngineIngressWithRecovery(runtime, ingress),
    acceptRecoveryIngress: (
      ingress: Parameters<EndpointEngine["acceptRecoveryIngress"]>[0],
    ) => acceptEngineRecoveryIngressWithRecovery(runtime, ingress),
    recoverCertifiedHistory: (
      recovery: Parameters<EndpointEngine["recoverCertifiedHistory"]>[0],
    ) => recoverCertifiedHistory(runtime, recovery),
    drainOutbound: drainOutbound(runtime).pipe(
      Effect.mapError(outboundFailure),
    ),
    runOutbound: runOutbound(runtime),
    abandonVolatileFolds: (
      reason: Parameters<EndpointEngine["abandonVolatileFolds"]>[0],
    ) => abandonVolatileFolds(runtime, reason),
  });

/**
 * Build one coherent private engine over registered identity and durable state.
 * @param input Verified identity, storage, Registry, and Router dependencies.
 * @returns A scoped engine whose recovered state is ready for protocol work.
 */
export const makeEndpointEngine = (
  input: EndpointEngineInput,
): Effect.Effect<EndpointEngine, EngineInitializationError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* initializeRuntime(input);
    yield* resumeRuntime(runtime);
    return endpointEngine(runtime);
  }).pipe(Effect.withSpan("makeEndpointEngine"));
