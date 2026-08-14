// safer-arch-ignore no-fat-orchestrator: EndpointEngine is the sole private composition boundary that wires the protocol phase modules behind the daemon-owned engine capability.
/** @file Private endpoint engine acquisition, START API, and daemon seams. */

import { AgentCard, AgentSigningAuthority } from "@moltzap/identity";
import { Deferred, Effect, Queue, SubscriptionRef, type Scope } from "effect";
import type { ConversationId, StartInput } from "../contract.js";
import {
  encodeCanonical,
  GenesisAnchor,
  hashAnchor,
  Membership,
} from "./representation.js";
import {
  acceptRemoteMulticast,
  startLocalMulticast,
} from "./engine-multicast.js";
import { makeOpenFloor } from "./openfloor.js";
import { acceptEngineIngress } from "./engine-protocol.js";
import { resumeActionFold } from "./engine-durability.js";
import { recoverEngineState } from "./engine-recovery.js";
import {
  acceptEngineRecoveryIngress,
  recoverCertifiedHistory,
} from "./engine-reanchor.js";
import {
  constructLocalStart,
  queueOuterEvidence,
  queueOuterPacket,
  resolveStart,
} from "./engine-start.js";
import {
  EngineAttentionError,
  EngineAttentionUnavailableError,
  type EndpointEngine,
  type EndpointEngineInput,
  EngineInitializationError,
  EngineListenerInUseError,
  EngineOutboundError,
  EngineReplyError,
  type EngineProspectiveTurn,
  type EngineRuntime,
  EngineStartError,
  type EngineTurnFrame,
  type EngineTurnListener,
  type EngineTurnSink,
  type EngineTurnWriteError,
} from "./engine-types.js";
import {
  RouterWorkerPersistenceError,
  type RouterWorkerSendError,
} from "./router-worker.js";
import { EndpointStoreError } from "./store.js";

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

const completionFor = (
  runtime: EngineRuntime,
  conversationId: ConversationId,
) =>
  Effect.gen(function* () {
    const retained = runtime.completions.get(conversationId);
    if (retained !== undefined) {
      return retained;
    }
    const completion = yield* Deferred.make<void, EngineStartError>();
    runtime.completions.set(conversationId, completion);
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
          if (
            !sameBytes(retained.canonicalIntent, resolved.canonicalIntent) ||
            retained.action.authorAgentId !==
              runtime.input.localAgentCard.agentId
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
        }

        const constructed = yield* constructLocalStart(
          runtime,
          input,
          resolved,
        );
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
        runtime.conversations.set(
          input.conversationId,
          constructed.conversation,
        );
        yield* queueOuterPacket(
          runtime,
          constructed.conversation,
          constructed.proposal,
        ).pipe(Effect.mapError(mapStartBlocked));
        return completion;
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
  grant: import("../harness-runtime.js").ReplyGrant,
  content: import("../contract.js").Content,
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
  Effect.acquireRelease(
    acquireSink(runtime, sink),
    (listener) => listener.detach,
  );

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
      const conversation = runtime.conversations.get(
        prospective.conversationId,
      );
      if (
        sink === undefined ||
        conversation?.head === undefined ||
        conversation.head.recordHash !== prospective.recordHash ||
        conversation.head.action.authorAgentId ===
          runtime.input.localAgentCard.agentId
      ) {
        return yield* Effect.fail(new EngineAttentionUnavailableError());
      }
      const frame: EngineTurnFrame = {
        conversationId: prospective.conversationId,
        peers: prospective.peers,
        author: prospective.author,
        content: prospective.content,
        replyGrant: prospective.replyGrant,
      };
      yield* Effect.uninterruptible(
        runtime.input.store
          .consumeAttention({
            conversationId: prospective.conversationId,
            recordHash: prospective.recordHash,
          })
          .pipe(
            Effect.mapError(() => new RouterWorkerPersistenceError()),
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
  reason: import("./router-worker.js").RouterDiscontinuityReason,
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
      { discard: true },
    );
    if (reason === "router_restarted") {
      yield* Effect.forEach(
        runtime.completions.values(),
        (completion) =>
          Deferred.fail(
            completion,
            new EngineStartError({ reason: "reanchor" }),
          ),
        { discard: true },
      );
    }
  });

/** Build one coherent private engine over registered identity and durable state. */
export const makeEndpointEngine = (
  input: EndpointEngineInput,
): Effect.Effect<EndpointEngine, EngineInitializationError, Scope.Scope> =>
  Effect.gen(function* () {
    if (
      AgentSigningAuthority.publicKey(input.signingAuthority).x !==
      input.localAgentCard.publicKey.x
    ) {
      return yield* Effect.fail(
        new EngineInitializationError({ reason: "identity" }),
      );
    }
    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      input.localAgentCard,
    ).pipe(
      Effect.mapError(
        () => new EngineInitializationError({ reason: "representation" }),
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
    const recovered = yield* recoverEngineState(input, recovery).pipe(
      Effect.mapError(
        () => new EngineInitializationError({ reason: "representation" }),
      ),
    );
    const runtime: EngineRuntime = {
      input,
      conversations: recovered.conversations,
      multicastFolds: recovered.multicastFolds,
      recordFolds: recovered.recordFolds,
      completions: new Map(),
      outbound: [],
      outboundSignal: yield* Queue.unbounded<void>(),
      gate: yield* Effect.makeSemaphore(1),
      outboundGate: yield* Effect.makeSemaphore(1),
      listenerGate: yield* Effect.makeSemaphore(1),
      revision: yield* SubscriptionRef.make(0),
    };
    runtime.openFloor = yield* makeOpenFloor({
      localAgentCard: input.localAgentCard,
      signingAuthority: input.signingAuthority,
      store: input.store,
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
    });
    yield* Effect.forEach(
      runtime.conversations.values(),
      (conversation) => {
        const head = conversation.head;
        if (head === undefined || runtime.openFloor === undefined) {
          return Effect.void;
        }
        return (
          conversation.currentAnchor.kind === "genesis_anchor"
            ? hashAnchor(conversation.currentAnchor)
            : Effect.succeed(conversation.currentAnchor.anchorHash)
        ).pipe(
          Effect.flatMap(
            (currentAnchorHash) =>
              runtime.openFloor?.certifiedHead({
                conversationId: conversation.conversationId,
                membership: conversation.membership,
                currentAnchorHash,
                recordHash: head.recordHash,
                record: head.certifiedRecord,
              }) ?? Effect.void,
          ),
          Effect.mapError(
            () => new EngineInitializationError({ reason: "representation" }),
          ),
        );
      },
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      runtime.recordFolds.values(),
      (fold) => resumeActionFold(runtime, fold),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.mapError(
        () => new EngineInitializationError({ reason: "persistence" }),
      ),
    );
    const engine: EndpointEngine = Object.freeze({
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
    return engine;
  }).pipe(Effect.withSpan("makeEndpointEngine"));
