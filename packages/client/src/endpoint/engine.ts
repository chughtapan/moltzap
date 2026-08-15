/** @file Private endpoint engine acquisition, START API, and daemon seams. */

import { AgentCard, AgentSigningAuthority } from "@moltzap/identity";
import { Deferred, Effect, Queue, type Scope, SubscriptionRef } from "effect";
import type { Content, ConversationId, StartInput } from "../contract.js";
import type { ReplyGrant } from "../harness-runtime.js";
import type { EndpointStoreError } from "./store.js";
import { resumeActionFold } from "./engine-durability.js";
import {
  acceptRemoteMulticast,
  startLocalMulticast,
} from "./engine-multicast.js";
import { acceptEngineIngress } from "./engine-protocol.js";
import {
  acceptEngineRecoveryIngress,
  recoverCertifiedHistory,
} from "./engine-reanchor.js";
import { recoverEngineState } from "./engine-recovery.js";
import {
  constructLocalStart,
  queueOuterEvidence,
  queueOuterPacket,
  resolveStart,
} from "./engine-start.js";
import {
  type EndpointEngine,
  type EndpointEngineInput,
  type EngineAttentionError,
  EngineAttentionUnavailableError,
  type EngineConversation,
  EngineInitializationError,
  EngineListenerInUseError,
  EngineOutboundError,
  type EngineProspectiveTurn,
  EngineReplyError,
  type EngineRuntime,
  EngineStartError,
  type EngineTurnFrame,
  type EngineTurnListener,
  type EngineTurnSink,
  type EngineTurnWriteError,
} from "./engine-types.js";
import { makeOpenFloor } from "./openfloor.js";
import {
  encodeCanonical,
  GenesisAnchor,
  hashAnchor,
  Membership,
} from "./representation.js";
import {
  type RouterDiscontinuityReason,
  RouterWorkerPersistenceError,
  type RouterWorkerSendError,
} from "./router-worker.js";

/** Closed engine errors used by daemon composition. */
export {
  EngineAttentionError,
  EngineAttentionUnavailableError,
  EngineInitializationError,
  EngineListenerInUseError,
  EngineOutboundError,
  EngineReplyError,
  EngineStartError,
  EngineTurnWriteError,
} from "./engine-types.js";
/** Private engine contracts retained behind the daemon boundary. */
export type {
  EndpointEngine,
  EndpointEngineInput,
  EngineActionFold,
  EngineCertifiedHead,
  EngineConversation,
  EngineMulticastFold,
  EngineProspectiveTurn,
  EngineRegistryPort,
  EngineRouterPort,
  EngineRuntime,
  EngineTurnFrame,
  EngineTurnListener,
  EngineTurnSink,
} from "./engine-types.js";

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const mapInitializationStoreError = (
  error: EndpointStoreError,
): EngineInitializationError =>
  new EngineInitializationError({
    reason: error.reason === "conflict" ? "identity" : "persistence",
  });

const mapStartStoreError = (error: EndpointStoreError): EngineStartError =>
  new EngineStartError({
    reason: error.reason === "conflict" ? "intent-conflict" : "persistence",
  });

const mapStartBlocked = (): EngineStartError =>
  new EngineStartError({ reason: "representation" });

const mapSendError = (error: RouterWorkerSendError): EngineOutboundError => {
  switch (error._tag) {
    case "RouterWorkerDiscontinuityError":
    case "RouterWorkerRecoveryError":
    case "RouterWorkerUnavailableError":
      return new EngineOutboundError({ reason: "reanchor" });
    case "RouterWorkerPersistenceError":
      return new EngineOutboundError({ reason: "persistence" });
    case "RouterWorkerAuthenticationError":
    case "RouterWorkerProtocolError":
      return new EngineOutboundError({ reason: "representation" });
    case "RouterWorkerTransportError":
      return new EngineOutboundError({ reason: "durability" });
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const mapOutboundToStart = (error: EngineOutboundError): EngineStartError =>
  new EngineStartError({ reason: error.reason });

const mapOutboundToReply = (error: EngineOutboundError): EngineReplyError =>
  new EngineReplyError({ reason: error.reason });

type StartCompletion =
  EngineRuntime["completions"] extends Map<ConversationId, infer Completion>
    ? Completion
    : never;

const makeStartCompletion: Effect.Effect<StartCompletion> = Deferred.make();

const completionFor = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
) =>
  Effect.gen(function* () {
    const retained = runtime.completions.get(conversationId);
    if (retained !== undefined) {
      return retained;
    }
    const completion = yield* makeStartCompletion;
    runtime.completions.set(conversationId, completion);
    return completion;
  });

const resumeRetainedStart = (
  runtime: EngineRuntime,
  resolved: Effect.Effect.Success<ReturnType<typeof resolveStart>>,
  completion: StartCompletion,
  retained: EngineConversation,
) =>
  Effect.gen(function* () {
    if (
      !sameBytes(retained.canonicalIntent, resolved.canonicalIntent) ||
      retained.action.authorAgentId !== runtime.input.localAgentCard.agentId
    ) {
      return yield* Effect.fail(
        new EngineStartError({ reason: "intent-conflict" }),
      );
    }
    if (retained.certifiedRecord !== undefined) {
      yield* Deferred.succeed(completion, undefined);
      return completion;
    }
    yield* queueOuterPacket(runtime, retained, {
      moltzapVersion: retained.action.moltzapVersion,
      kind: "start_proposal",
      membership: retained.membership.membership,
      genesisAnchor: retained.genesisAnchor,
      action: retained.action,
    }).pipe(Effect.mapError(mapStartBlocked));
    yield* resumeActionFold(runtime, retained).pipe(
      Effect.mapError((error) =>
        error._tag === "EndpointStoreError"
          ? mapStartStoreError(error)
          : mapStartBlocked(),
      ),
    );
    return completion;
  });

const constructFreshStart = (
  runtime: EngineRuntime,
  input: StartInput,
  resolved: Effect.Effect.Success<ReturnType<typeof resolveStart>>,
  completion: StartCompletion,
) =>
  Effect.gen(function* () {
    const constructed = yield* constructLocalStart(runtime, input, resolved);
    yield* runtime.input.store
      .putConversationFoundation({
        conversationId: input.conversationId,
        membershipHash: constructed.conversation.membership.hash,
        canonicalMembership: yield* encodeCanonical(
          Membership,
          constructed.conversation.membership.membership,
        ).pipe(Effect.mapError(mapStartBlocked)),
        anchorHash: constructed.conversation.action.anchorHash,
        canonicalAnchor: yield* encodeCanonical(
          GenesisAnchor,
          constructed.conversation.genesisAnchor,
        ).pipe(Effect.mapError(mapStartBlocked)),
      })
      .pipe(Effect.mapError(mapStartStoreError));
    runtime.conversations.set(input.conversationId, constructed.conversation);
    yield* queueOuterPacket(
      runtime,
      constructed.conversation,
      constructed.proposal,
    ).pipe(Effect.mapError(mapStartBlocked));
    return completion;
  });

const prepareStart = (
  runtime: EngineRuntime,
  input: StartInput,
): Effect.Effect<Deferred.Deferred<void, EngineStartError>, EngineStartError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveStart(runtime, input);
    yield* runtime.input.store
      .bindStartIntent({
        conversationId: input.conversationId,
        canonicalIntent: resolved.canonicalIntent,
      })
      .pipe(Effect.mapError(mapStartStoreError));

    return yield* runtime.gate.withPermits(1)(
      Effect.gen(function* () {
        const completion = yield* completionFor(runtime, input.conversationId);
        const retained = runtime.conversations.get(input.conversationId);
        if (retained !== undefined) {
          return yield* resumeRetainedStart(
            runtime,
            resolved,
            completion,
            retained,
          );
        }
        return yield* constructFreshStart(runtime, input, resolved, completion);
      }),
    );
  });

const drainOutbound = (
  runtime: EngineRuntime,
): Effect.Effect<void, EngineOutboundError> =>
  runtime.outboundGate.withPermits(1)(
    Effect.gen(function* () {
      while (runtime.outbound.length > 0) {
        const message = runtime.outbound[0];
        if (message === undefined) {
          return;
        }
        yield* runtime.input.routerWorker
          .send(message)
          .pipe(Effect.mapError(mapSendError));
        runtime.outbound.shift();
      }
    }),
  );

const start = (
  runtime: EngineRuntime,
  input: StartInput,
): Effect.Effect<void, EngineStartError> =>
  Effect.gen(function* () {
    const completion = yield* prepareStart(runtime, input);
    yield* drainOutbound(runtime).pipe(Effect.mapError(mapOutboundToStart));
    yield* Deferred.await(completion);
  }).pipe(Effect.withSpan("EndpointEngine.start"));

const reply = (
  runtime: EngineRuntime,
  grant: ReplyGrant,
  content: Content,
): Effect.Effect<void, EngineReplyError> =>
  Effect.gen(function* () {
    const openFloor = runtime.openFloor;
    if (openFloor === undefined) {
      return yield* Effect.fail(
        new EngineReplyError({ reason: "authority-unavailable" }),
      );
    }
    const candidate = yield* openFloor.admitReply(grant, content);
    const fold = yield* runtime.gate.withPermits(1)(
      startLocalMulticast(runtime, candidate),
    );
    yield* drainOutbound(runtime).pipe(Effect.mapError(mapOutboundToReply));
    yield* Deferred.await(fold.completion);
  }).pipe(Effect.withSpan("EndpointEngine.reply"));

const runOutbound = (
  runtime: EngineRuntime,
): Effect.Effect<never, EngineOutboundError> =>
  Queue.take(runtime.outboundSignal).pipe(
    Effect.zipRight(drainOutbound(runtime)),
    Effect.forever,
  );

const detachSink = (
  runtime: EngineRuntime,
  sink: EngineTurnSink,
): Effect.Effect<void> =>
  (runtime.openFloor?.listenerDetached ?? Effect.void).pipe(
    Effect.zipRight(
      runtime.listenerGate.withPermits(1)(
        Effect.sync(() => {
          if (runtime.activeSink === sink) {
            runtime.activeSink = undefined;
          }
        }),
      ),
    ),
  );

const acquireSink = (
  runtime: EngineRuntime,
  sink: EngineTurnSink,
): Effect.Effect<
  EngineTurnListener,
  EngineListenerInUseError | EngineAttentionError
> =>
  Effect.gen(function* () {
    yield* runtime.listenerGate.withPermits(1)(
      Effect.gen(function* () {
        if (runtime.activeSink !== undefined) {
          return yield* Effect.fail(new EngineListenerInUseError());
        }
        runtime.activeSink = sink;
      }),
    );
    yield* (runtime.openFloor?.listenerAttached ?? Effect.void).pipe(
      Effect.tapError(() =>
        runtime.listenerGate.withPermits(1)(
          Effect.sync(() => {
            if (runtime.activeSink === sink) {
              runtime.activeSink = undefined;
            }
          }),
        ),
      ),
    );
    return Object.freeze({ detach: detachSink(runtime, sink) });
  });

const acquireTurnSink = (
  runtime: EngineRuntime,
  sink: EngineTurnSink,
): Effect.Effect<
  EngineTurnListener,
  EngineListenerInUseError | EngineAttentionError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const listener = yield* acquireSink(runtime, sink);
    yield* Effect.addFinalizer(() => listener.detach);
    return listener;
  });

const prospectiveFrame = (
  runtime: EngineRuntime,
  prospective: EngineProspectiveTurn,
): EngineTurnFrame | undefined => {
  const conversation = runtime.conversations.get(prospective.conversationId);
  if (
    conversation?.head === undefined ||
    conversation.head.recordHash !== prospective.recordHash ||
    conversation.head.action.authorAgentId ===
      runtime.input.localAgentCard.agentId
  ) {
    return undefined;
  }
  return {
    conversationId: prospective.conversationId,
    peers: prospective.peers,
    author: prospective.author,
    content: prospective.content,
    replyGrant: prospective.replyGrant,
  };
};

const deliverTurn = (
  runtime: EngineRuntime,
  prospective: EngineProspectiveTurn,
): Effect.Effect<
  void,
  | EngineAttentionUnavailableError
  | EngineTurnWriteError
  | RouterWorkerPersistenceError
> =>
  runtime.listenerGate.withPermits(1)(
    Effect.gen(function* () {
      const sink = runtime.activeSink;
      const frame = prospectiveFrame(runtime, prospective);
      if (sink === undefined || frame === undefined) {
        return yield* Effect.fail(new EngineAttentionUnavailableError());
      }
      yield* Effect.uninterruptible(
        runtime.input.store
          .consumeAttention({
            conversationId: prospective.conversationId,
            recordHash: prospective.recordHash,
          })
          .pipe(
            Effect.catchTag("EndpointStoreError", () =>
              Effect.fail(new RouterWorkerPersistenceError()),
            ),
            Effect.flatMap(
              (
                mutation,
              ): Effect.Effect<
                void,
                EngineAttentionUnavailableError | EngineTurnWriteError
              > =>
                mutation === "inserted"
                  ? sink.write(frame)
                  : Effect.fail(new EngineAttentionUnavailableError()),
            ),
          ),
      );
    }),
  );

const abandonVolatileFolds = (
  runtime: EngineRuntime,
  reason: RouterDiscontinuityReason,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* runtime.outboundGate.withPermits(1)(
      Effect.sync(() => {
        runtime.outbound.length = 0;
        for (const conversation of runtime.conversations.values()) {
          conversation.actionSignatureQueued = false;
          conversation.durabilityVoteQueued = false;
          conversation.certifiedBroadcastQueued =
            conversation.certifiedRecord !== undefined;
        }
      }),
    );
    yield* runtime.openFloor?.abandon ?? Effect.void;
    yield* Effect.forEach(
      runtime.multicastFolds.values(),
      (fold) =>
        fold.certifiedRecord === undefined
          ? Deferred.fail(
              fold.completion,
              new EngineReplyError({ reason: "reanchor" }),
            )
          : Effect.void,
      { concurrency: 1, discard: true },
    );
    if (reason === "router_restarted") {
      yield* Effect.forEach(
        runtime.completions.values(),
        (completion) =>
          Deferred.fail(
            completion,
            new EngineStartError({ reason: "reanchor" }),
          ),
        { concurrency: 1, discard: true },
      );
    }
  });

const validateLocalIdentity = (
  input: EndpointEngineInput,
): Effect.Effect<void, EngineInitializationError> =>
  AgentSigningAuthority.publicKey(input.signingAuthority).x ===
  input.localAgentCard.publicKey.x
    ? Effect.void
    : Effect.fail(new EngineInitializationError({ reason: "identity" }));

const recoverInitialState = (input: EndpointEngineInput) =>
  Effect.gen(function* () {
    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      input.localAgentCard,
    ).pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.fail(
          new EngineInitializationError({ reason: "representation" }),
        ),
      ),
    );
    yield* input.store
      .bindIdentity({
        agentId: input.localAgentCard.agentId,
        canonicalAgentCard,
      })
      .pipe(Effect.mapError(mapInitializationStoreError));
    const recovery = yield* input.store
      .recover()
      .pipe(Effect.mapError(mapInitializationStoreError));
    return yield* recoverEngineState(input, recovery).pipe(
      Effect.catchTag("ClientRepresentationError", () =>
        Effect.fail(
          new EngineInitializationError({ reason: "representation" }),
        ),
      ),
    );
  });

const initializeRuntime = (input: EndpointEngineInput) =>
  Effect.gen(function* () {
    yield* validateLocalIdentity(input);
    const recovered = yield* recoverInitialState(input);
    const runtime: EngineRuntime = {
      input,
      conversations: recovered.conversations,
      multicastFolds: recovered.multicastFolds,
      recordFolds: recovered.recordFolds,
      completions: new Map(),
      outbound: [],
      outboundSignal: yield* Queue.unbounded<undefined>(),
      gate: yield* Effect.makeSemaphore(1),
      outboundGate: yield* Effect.makeSemaphore(1),
      listenerGate: yield* Effect.makeSemaphore(1),
      revision: yield* SubscriptionRef.make(0),
    };
    return runtime;
  });

const attachOpenFloor = (runtime: EngineRuntime) =>
  makeOpenFloor({
    localAgentCard: runtime.input.localAgentCard,
    signingAuthority: runtime.input.signingAuthority,
    store: runtime.input.store,
    actions: {
      queueBegin: (membership, begin) =>
        queueOuterPacket(runtime, { membership }, begin),
      queueEvidence: (membership, evidence) =>
        queueOuterEvidence(runtime, { membership }, evidence),
      onMulticastCandidate: (candidate) =>
        acceptRemoteMulticast(runtime, candidate),
      deliverTurn: (turn) =>
        deliverTurn(runtime, turn).pipe(
          Effect.catchTags({
            EngineAttentionUnavailableError: () => Effect.void,
            EngineTurnWriteError: () => Effect.void,
          }),
        ),
    },
  }).pipe(
    Effect.tap((openFloor) =>
      Effect.sync(() => {
        runtime.openFloor = openFloor;
      }),
    ),
    Effect.asVoid,
  );

const restoreCertifiedHead = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
) => {
  const head = conversation.head;
  if (head === undefined || runtime.openFloor === undefined) {
    return Effect.void;
  }
  return (
    conversation.currentAnchor.kind === "genesis_anchor"
      ? hashAnchor(conversation.currentAnchor)
      : Effect.succeed(conversation.currentAnchor.anchorHash)
  ).pipe(
    Effect.flatMap((currentAnchorHash) =>
      runtime.openFloor === undefined
        ? Effect.void
        : runtime.openFloor.certifiedHead({
            conversationId: conversation.conversationId,
            membership: conversation.membership,
            currentAnchorHash,
            recordHash: head.recordHash,
            record: head.certifiedRecord,
          }),
    ),
    Effect.catchTags({
      ClientRepresentationError: () =>
        Effect.fail(
          new EngineInitializationError({ reason: "representation" }),
        ),
      EngineAttentionError: () =>
        Effect.fail(
          new EngineInitializationError({ reason: "representation" }),
        ),
    }),
  );
};

const restoreCertifiedHeads = (runtime: EngineRuntime) =>
  Effect.forEach(
    runtime.conversations.values(),
    (conversation) => restoreCertifiedHead(runtime, conversation),
    { concurrency: 1, discard: true },
  );

const resumeRecoveredFolds = (runtime: EngineRuntime) =>
  Effect.forEach(
    runtime.recordFolds.values(),
    (fold) => resumeActionFold(runtime, fold),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.catchTags({
      EndpointStoreError: () =>
        Effect.fail(new EngineInitializationError({ reason: "persistence" })),
      RouterWorkerPersistenceError: () =>
        Effect.fail(new EngineInitializationError({ reason: "persistence" })),
    }),
  );

const endpointEngine = (runtime: EngineRuntime): EndpointEngine =>
  Object.freeze({
    start: (startInput: StartInput) => start(runtime, startInput),
    reply: (
      grant: Parameters<EndpointEngine["reply"]>[0],
      content: Parameters<EndpointEngine["reply"]>[1],
    ) => reply(runtime, grant, content),
    acceptRouterIngress: (
      ingress: Parameters<EndpointEngine["acceptRouterIngress"]>[0],
    ) => acceptEngineIngress(runtime, ingress),
    acceptRecoveryIngress: (
      ingress: Parameters<EndpointEngine["acceptRecoveryIngress"]>[0],
    ) => acceptEngineRecoveryIngress(runtime, ingress),
    recoverCertifiedHistory: (
      recoveryInput: Parameters<EndpointEngine["recoverCertifiedHistory"]>[0],
    ) => recoverCertifiedHistory(runtime, recoveryInput),
    drainOutbound: drainOutbound(runtime),
    runOutbound: runOutbound(runtime),
    abandonVolatileFolds: (
      reason: Parameters<EndpointEngine["abandonVolatileFolds"]>[0],
    ) => abandonVolatileFolds(runtime, reason),
    acquireTurnSink: (sink: EngineTurnSink) => acquireTurnSink(runtime, sink),
    deliverTurn: (turn: EngineProspectiveTurn) => deliverTurn(runtime, turn),
  });

/**
 * Build one coherent private engine over registered identity and durable state.
 * @param input Stable identity, store, Registry, Router, and signing dependencies.
 * @returns The scoped private endpoint engine capability.
 */
// safer-arch-ignore no-fat-orchestrator: EndpointEngine is the sole private composition boundary that wires the protocol phase modules behind the daemon-owned engine capability.
export const makeEndpointEngine = (
  input: EndpointEngineInput,
): Effect.Effect<EndpointEngine, EngineInitializationError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* initializeRuntime(input);
    yield* attachOpenFloor(runtime);
    yield* restoreCertifiedHeads(runtime);
    yield* resumeRecoveredFolds(runtime);
    return endpointEngine(runtime);
  }).pipe(Effect.withSpan("makeEndpointEngine"));
