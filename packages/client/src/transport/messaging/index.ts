/**
 * @file Private addressed-message engine: its contract with daemon
 * composition, and the assembly that binds the phases into one engine.
 */

import { AgentCard, AgentSigningAuthority } from "@moltzap/identity";
import { Data, Deferred, Duration, Effect, Schema, type Scope } from "effect";
import type { DeliveryToken, EndpointStoreError } from "../../store/index.js";
import type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerRecovery,
  RouterWorkerRecoveryError,
  RouterWorkerSendError,
} from "../router/index.js";
import type {
  EndpointEngineInput,
  EnginePhases,
  EngineRuntime,
} from "./runtime/index.js";
import {
  type ClientRepresentationError,
  decodeCanonical,
  type DecodedOuterBody,
  encodeCanonical,
  type MessageAddressInput,
  PostIntent,
  RecordHash,
} from "../wire/index.js";
import {
  acceptEngineIngress,
  acceptEngineRecoveryIngress,
  resumeDisseminationObligations,
  resumeEngineFolds,
} from "./certification/index.js";
import { DeliveryAcknowledgeError, ListenError, SendError } from "./errors.js";
import { InboundMessage } from "./message.js";
import { makeOutbox } from "./outbox.js";
import {
  acceptEngineIngressWithRecovery,
  installRecoveryBarrier,
  rearmPausedCatchUp,
  recoverCertifiedHistory,
} from "./recovery/index.js";
import {
  type EngineSendInput,
  type EngineSentPost,
  prepareSend,
  proposeIntent,
  resolveAddress,
} from "./send.js";
import { recoverEngineState } from "./startup.js";

/** Private engine dependencies retained behind the daemon boundary. */
export type { EndpointEngineInput } from "./runtime/index.js";
/** The send input and result the collective layer exchanges with the engine. */
export type { EngineSendInput, EngineSentPost } from "./send.js";
/**
 * The one verifier of a stored membership row, and the stored-history reader
 * the owner tools page through, shared with the daemon.
 */
export { readStoredHistory, verifyStoredMembership } from "./history/index.js";

/** Engine acquisition could not establish one coherent durable endpoint. */
export class EngineInitializationError extends Data.TaggedError(
  "EngineInitializationError",
)<{
  readonly reason: "identity" | "persistence" | "representation";
}> {}

/** Sending queued protocol traffic could not complete safely. */
export class EngineOutboundError extends Data.TaggedError(
  "EngineOutboundError",
)<{
  readonly reason: "network" | "persistence" | "representation" | "version";
}> {}

/**
 * One durable delivery decoded for the daemon's sole subscriber. `message` is
 * the certified post with its complete content, collective part included; the
 * daemon's classifier turns it into the item the subscriber receives.
 * `recordHash` names the certified record the delivery derives from; it stays
 * inside the daemon and never reaches the MCP event.
 */
export interface EnginePendingMessage {
  readonly deliveryToken: DeliveryToken;
  readonly recordHash: RecordHash;
  readonly message: InboundMessage;
}

/** Stable private engine capability consumed by daemon composition. */
export interface EndpointEngine {
  /** Completes once the minted post's certified record is stored locally. */
  readonly send: (
    input: EngineSendInput,
  ) => Effect.Effect<EngineSentPost, SendError>;
  /**
   * Resolve an address through the Registry as a send would, without
   * sending; the collective layer uses it to name the unreachable members of
   * a refused group post.
   */
  readonly resolveAddress: (
    to: MessageAddressInput,
  ) => Effect.Effect<void, SendError>;
  readonly readPendingMessages: () => Effect.Effect<
    readonly EnginePendingMessage[],
    ListenError
  >;
  readonly acknowledgeMessage: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, DeliveryAcknowledgeError>;
  readonly acceptRouterIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly acceptRecoveryIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly recoverCertifiedHistory: (
    recovery: RouterWorkerRecovery,
  ) => Effect.Effect<void, RouterWorkerRecoveryError>;
  readonly drainOutbound: Effect.Effect<void, EngineOutboundError>;
  readonly runOutbound: Effect.Effect<never, EngineOutboundError>;
  readonly abandonVolatileFolds: (
    reason: RouterDiscontinuityReason,
  ) => Effect.Effect<void>;
  /**
   * Start catch-up again for every conversation recovery still holds whose
   * retries ran out; the Router worker calls it when it reattaches.
   */
  readonly rearmCatchUp: Effect.Effect<void>;
}

type RecoveredStateError = Effect.Effect.Error<
  ReturnType<typeof recoverEngineState>
>;

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

const send = (
  runtime: EngineRuntime,
  input: EngineSendInput,
): Effect.Effect<EngineSentPost, SendError> =>
  Effect.gen(function* () {
    const prepared = yield* prepareSend(runtime, input);
    yield* runtime.outbox.drain.pipe(
      Effect.mapError((error) => outboundSendFailure(outboundFailure(error))),
      Effect.timeoutFail({
        duration: LOCAL_DRAIN_TIMEOUT,
        onTimeout: () => new SendError({ reason: "network-unavailable" }),
      }),
    );
    const recordHash = yield* Deferred.await(prepared.completion);
    return { postId: prepared.postId, recordHash };
  }).pipe(Effect.withSpan("EndpointEngine.send"));

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

/** Each engine phase that another phase starts, bound once for every runtime. */
const enginePhases: EnginePhases = {
  proposeIntent,
  acceptIngress: acceptEngineIngress,
  acceptRecoveryIngress: acceptEngineRecoveryIngress,
  resumeFolds: resumeEngineFolds,
  resumeDissemination: resumeDisseminationObligations,
  rearmCatchUp: rearmPausedCatchUp,
};

const makeRuntime = (
  input: EndpointEngineInput,
  recovered: Effect.Effect.Success<ReturnType<typeof recoverEngineState>>,
  scope: Scope.Scope,
): Effect.Effect<EngineRuntime> =>
  Effect.gen(function* () {
    return {
      input,
      conversations: recovered.conversations,
      intents: new Map(),
      completedPosts: recovered.completedPosts,
      actionFolds: recovered.actionFolds,
      recordFolds: recovered.recordFolds,
      gate: yield* Effect.makeSemaphore(1),
      outbox: yield* makeOutbox(
        input,
        recovered.outboundMessages.map((message) => message.outboundId),
      ),
      phases: enginePhases,
      scope,
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
): Effect.Effect<EngineRuntime, EngineInitializationError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* validateLocalIdentity(input);
    yield* bindLocalIdentity(input);
    const recovery = yield* input.store
      .recover()
      .pipe(Effect.mapError(initializationStoreFailure));
    const recovered = yield* recoverEngineState(input, recovery).pipe(
      Effect.mapError(recoveryInitializationFailure),
    );
    const runtime = yield* makeRuntime(input, recovered, yield* Effect.scope);
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
          runtime.outbox.clear();
          if (reason !== "router_restarted") {
            return;
          }
          for (const fold of runtime.actionFolds.values()) {
            fold.localActionEvidenceQueued = false;
            fold.localDurabilityEvidenceQueued = false;
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
    ) => acceptEngineIngressWithRecovery(runtime, ingress),
    recoverCertifiedHistory: (
      recovery: Parameters<EndpointEngine["recoverCertifiedHistory"]>[0],
    ) => recoverCertifiedHistory(runtime, recovery),
    drainOutbound: runtime.outbox.drain.pipe(Effect.mapError(outboundFailure)),
    runOutbound: runtime.outbox.run.pipe(Effect.mapError(outboundFailure)),
    abandonVolatileFolds: (
      reason: Parameters<EndpointEngine["abandonVolatileFolds"]>[0],
    ) => abandonVolatileFolds(runtime, reason),
    rearmCatchUp: rearmPausedCatchUp(runtime),
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
