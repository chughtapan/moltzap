/** @file Private lifecycle composition for one registered endpoint daemon. */

import type { Implementation } from "@modelcontextprotocol/server";
import {
  AgentCard,
  type AgentId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  ExecutionStrategy,
  Exit,
  Queue,
  Schema,
  Scope,
} from "effect";
import packageJson from "../../package.json" with { type: "json" };
import {
  EngineReplyError,
  EngineStartError,
  EngineTurnWriteError,
  makeEndpointEngine,
} from "../endpoint/engine.js";
import type {
  EndpointEngine,
  EndpointEngineInput,
  EngineTurnFrame,
  EngineTurnSink,
} from "../endpoint/engine.js";
import {
  Membership,
  decodeCanonical,
  encodeCanonical,
  verifyMembership,
} from "../endpoint/representation.js";
import {
  makeRouterWorker,
  type RouterWorker,
  type RouterWorkerInput,
  type RouterWorkerProtocolError,
  type RouterWorkerTransportError,
} from "../endpoint/router-worker.js";
import type { EndpointStore } from "../endpoint/store.js";
import { acquireHarnessMcpHttpServer } from "../harness-mcp-http.js";
import type { HarnessMcpSubscriptionHandler } from "../harness-mcp-subscription.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "../harness-mcp-wire.js";
import type { HarnessTurnEvent } from "../harness-runtime.js";
import type { DaemonBootstrap } from "./configuration.js";
import {
  type DaemonManagementOperations,
  makeDaemonManagementOperations,
} from "./management.js";
import {
  type DaemonRegistrationState,
  readDaemonRegistrationState,
} from "./registration.js";

const DAEMON_IMPLEMENTATION = {
  name: "moltzapd",
  version: packageJson.version,
} satisfies Implementation;

type SubscriptionHandler = HarnessMcpSubscriptionHandler<HarnessTurnEvent>;

/** Closed private daemon failure projected onto the public startup phases. */
export class DaemonRuntimeError extends Data.TaggedError("DaemonRuntimeError")<{
  readonly phase: "storage" | "listener";
}> {}

class DaemonActivationError extends Data.TaggedError("DaemonActivationError")<{
  readonly reason: "upstream" | "persistence" | "representation";
}> {}

/** Replaceable process edges used only by focused lifecycle tests. */
export interface DaemonRuntimeDependencies {
  readonly makeWorker: (
    input: RouterWorkerInput,
  ) => Effect.Effect<
    RouterWorker,
    RouterWorkerTransportError | RouterWorkerProtocolError,
    Registry | Router
  >;
  readonly makeEngine: (
    input: EndpointEngineInput,
  ) => ReturnType<typeof makeEndpointEngine>;
  readonly makeHandler: typeof makeHarnessMcpHttpHandler;
  readonly acquireListener: (input: {
    readonly port: number;
    readonly handler: SubscriptionHandler;
  }) => Effect.Effect<void, Error, Scope.Scope>;
}

interface ActiveProtocol {
  readonly agentCard: VerifiedAgentCard;
  readonly worker: RouterWorker;
  readonly engine: EndpointEngine;
}

interface DaemonController {
  readonly operations: HarnessMcpOperations;
  readonly subscriptionChanged: (active: boolean) => void;
  readonly installHandler: (
    handler: SubscriptionHandler,
  ) => Effect.Effect<void>;
  readonly runSubscriptions: Effect.Effect<never, DaemonRuntimeError>;
  readonly awaitFailure: Effect.Effect<never, DaemonRuntimeError>;
  readonly initializeAtStart: (
    state: DaemonRegistrationState,
  ) => Effect.Effect<void, DaemonRuntimeError>;
}

const productionDependencies: DaemonRuntimeDependencies = {
  makeWorker: (input) => makeRouterWorker(input),
  makeEngine: makeEndpointEngine,
  makeHandler: makeHarnessMcpHttpHandler,
  acquireListener: ({ port, handler }) =>
    acquireHarnessMcpHttpServer({ port, handler }).pipe(Effect.asVoid),
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const activationFailure = (
  reason: DaemonActivationError["reason"],
): DaemonActivationError => new DaemonActivationError({ reason });

const runtimeFailure = (
  phase: DaemonRuntimeError["phase"],
): DaemonRuntimeError => new DaemonRuntimeError({ phase });

const activationRuntimeFailure = (
  error: DaemonActivationError,
): DaemonRuntimeError =>
  runtimeFailure(error.reason === "upstream" ? "listener" : "storage");

const mapWorkerInitializationError = (
  error: RouterWorkerTransportError | RouterWorkerProtocolError,
): DaemonActivationError =>
  activationFailure(
    error._tag === "RouterWorkerTransportError" ? "upstream" : "representation",
  );

const encodeCard = (
  card: VerifiedAgentCard,
): Effect.Effect<Uint8Array, DaemonActivationError> =>
  encodeCanonical(AgentCard, card).pipe(
    Effect.mapError(() => activationFailure("representation")),
  );

const recoverPinnedSenderCards = (input: {
  readonly store: EndpointStore;
  readonly localAgentCard: VerifiedAgentCard;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<readonly VerifiedAgentCard[], DaemonActivationError> =>
  Effect.gen(function* () {
    const recovery = yield* input.store
      .recover()
      .pipe(Effect.mapError(() => activationFailure("persistence")));
    const cards = new Map<AgentId, VerifiedAgentCard>();
    const representations = new Map<AgentId, Uint8Array>();

    const retain = (card: VerifiedAgentCard) =>
      Effect.gen(function* () {
        const canonical = yield* encodeCard(card);
        const existing = representations.get(card.agentId);
        if (existing !== undefined && !sameBytes(existing, canonical)) {
          return yield* Effect.fail(activationFailure("representation"));
        }
        cards.set(card.agentId, card);
        representations.set(card.agentId, canonical);
      });

    yield* retain(input.localAgentCard);
    yield* Effect.forEach(
      recovery.memberships,
      (stored) =>
        Effect.gen(function* () {
          const membership = yield* decodeCanonical(
            Membership,
            stored.canonicalMembership,
          ).pipe(Effect.mapError(() => activationFailure("representation")));
          const verified = yield* verifyMembership(
            membership,
            input.bootstrap.configuration.registrySignerPublicKey,
          ).pipe(Effect.mapError(() => activationFailure("representation")));
          if (
            membership.conversationId !== stored.conversationId ||
            verified.hash !== stored.membershipHash
          ) {
            return yield* Effect.fail(activationFailure("representation"));
          }
          yield* Effect.forEach(verified.members, retain, {
            concurrency: 1,
            discard: true,
          });
        }),
      { concurrency: 1, discard: true },
    );
    return [...cards.values()].sort((left, right) =>
      left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0,
    );
  });

const encodeTurnEvent = (
  turn: EngineTurnFrame,
): Effect.Effect<HarnessTurnEvent, EngineTurnWriteError> =>
  Effect.gen(function* () {
    const mapError = () => new EngineTurnWriteError();
    const [firstPeer, ...remainingPeers] = turn.peers;
    const encodedFirst = yield* Schema.encode(AgentCard)(firstPeer).pipe(
      Effect.mapError(mapError),
    );
    const encodedRemaining = yield* Effect.forEach(
      remainingPeers,
      (peer) => Schema.encode(AgentCard)(peer).pipe(Effect.mapError(mapError)),
      { concurrency: 1 },
    );
    const author = yield* Schema.encode(AgentCard)(turn.author).pipe(
      Effect.mapError(mapError),
    );
    return {
      conversationId: turn.conversationId,
      peers: [encodedFirst, ...encodedRemaining],
      author,
      content: turn.content,
      replyGrant: turn.replyGrant,
    };
  });

const makeDaemonController = (input: {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
  readonly management: DaemonManagementOperations;
  readonly dependencies: DaemonRuntimeDependencies;
}): Effect.Effect<DaemonController, never, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const router = yield* Router;
    const daemonScope = yield* Scope.Scope;
    const activationGate = yield* Effect.makeSemaphore(1);
    const listenerGate = yield* Effect.makeSemaphore(1);
    const subscriptionChanges = yield* Queue.unbounded<boolean>();
    const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
    let activeProtocol: ActiveProtocol | undefined;
    let subscriptionActive = false;
    let listenerScope: Scope.CloseableScope | undefined;
    let handler: SubscriptionHandler | undefined;

    const sink: EngineTurnSink = {
      write: (turn) =>
        encodeTurnEvent(turn).pipe(
          Effect.flatMap((event) =>
            Effect.sync(() => handler?.publish(event) === true).pipe(
              Effect.filterOrFail(
                (published) => published,
                () => new EngineTurnWriteError(),
              ),
            ),
          ),
          Effect.asVoid,
        ),
    };

    const closeListener = (): Effect.Effect<void> => {
      const scope = listenerScope;
      listenerScope = undefined;
      return scope === undefined ? Effect.void : Scope.close(scope, Exit.void);
    };

    const reconcileListener = listenerGate.withPermits(1)(
      Effect.gen(function* () {
        if (!subscriptionActive || activeProtocol === undefined) {
          yield* closeListener();
          return;
        }
        if (listenerScope !== undefined) {
          return;
        }
        const scope = yield* Scope.fork(
          daemonScope,
          ExecutionStrategy.sequential,
        );
        const acquired = yield* activeProtocol.engine
          .acquireTurnSink(sink)
          .pipe(Scope.extend(scope), Effect.exit);
        if (Exit.isFailure(acquired)) {
          yield* Scope.close(scope, acquired);
          return yield* Effect.fail(runtimeFailure("listener"));
        }
        listenerScope = scope;
      }),
    );

    const supervise = (effect: Effect.Effect<never, unknown>) =>
      effect.pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause)
            : Deferred.fail(fatal, runtimeFailure("listener")).pipe(
                Effect.zipRight(Effect.never),
              ),
        ),
        Effect.interruptible,
        Effect.forkIn(daemonScope),
        Effect.asVoid,
      );

    const initialize = (
      agentCard: VerifiedAgentCard,
    ): Effect.Effect<void, DaemonActivationError> =>
      activationGate.withPermits(1)(
        Effect.gen(function* () {
          if (activeProtocol !== undefined) {
            if (
              activeProtocol.agentCard.agentId !== agentCard.agentId ||
              activeProtocol.agentCard.publicKey.x !== agentCard.publicKey.x
            ) {
              return yield* Effect.fail(activationFailure("representation"));
            }
            return;
          }
          const pinnedSenderCards = yield* recoverPinnedSenderCards({
            store: input.store,
            localAgentCard: agentCard,
            bootstrap: input.bootstrap,
          });
          const engineReady = yield* Deferred.make<EndpointEngine>();
          const awaitEngine = Deferred.await(engineReady);
          const worker = yield* input.dependencies
            .makeWorker({
              callerAgentId: agentCard.agentId,
              callerAgentCard: agentCard,
              pinnedSenderCards,
              signingAuthority: input.bootstrap.signingAuthority,
              callbacks: {
                pinSenderCard: () => awaitEngine.pipe(Effect.asVoid),
                acceptPayload: (ingress) =>
                  awaitEngine.pipe(
                    Effect.flatMap((engine) =>
                      engine.acceptRouterIngress(ingress),
                    ),
                  ),
                acceptRecoveryPayload: (ingress) =>
                  awaitEngine.pipe(
                    Effect.flatMap((engine) =>
                      engine.acceptRecoveryIngress(ingress),
                    ),
                  ),
                abandonVolatileFolds: (reason) =>
                  awaitEngine.pipe(
                    Effect.flatMap((engine) =>
                      engine.abandonVolatileFolds(reason),
                    ),
                  ),
                recoverCertifiedHistory: (recovery) =>
                  awaitEngine.pipe(
                    Effect.flatMap((engine) =>
                      engine.recoverCertifiedHistory(recovery),
                    ),
                  ),
              },
            })
            .pipe(
              Effect.provideService(Registry, registry),
              Effect.provideService(Router, router),
              Effect.mapError(mapWorkerInitializationError),
            );
          const engine = yield* input.dependencies
            .makeEngine({
              localAgentCard: agentCard,
              signingAuthority: input.bootstrap.signingAuthority,
              registrySignerPublicKey:
                input.bootstrap.configuration.registrySignerPublicKey,
              registry,
              store: input.store,
              routerWorker: worker,
            })
            .pipe(
              Scope.extend(daemonScope),
              Effect.mapError((error) =>
                activationFailure(
                  error.reason === "identity" ? "representation" : error.reason,
                ),
              ),
            );
          activeProtocol = { agentCard, worker, engine };
          yield* Deferred.succeed(engineReady, engine);
          yield* supervise(worker.run);
          yield* supervise(engine.runOutbound);
          yield* reconcileListener.pipe(
            Effect.mapError(() => activationFailure("upstream")),
          );
        }),
      );

    const register: HarnessMcpOperations["register"] = (request) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* input.management.register(request);
          if (result.kind !== "registered") {
            return result;
          }
          yield* readDaemonRegistrationState({
            store: input.store,
            bootstrap: input.bootstrap,
          }).pipe(
            Effect.mapError((error) =>
              activationFailure(
                error._tag === "DaemonRegistrationPersistenceError"
                  ? "persistence"
                  : "representation",
              ),
            ),
            Effect.flatMap((state) =>
              state.kind === "active"
                ? initialize(state.agentCard)
                : Effect.fail(activationFailure("persistence")),
            ),
            Effect.tapError((error) =>
              Deferred.fail(fatal, activationRuntimeFailure(error)),
            ),
          );
          return result;
        }),
      );

    const start: HarnessMcpOperations["start"] = (request) =>
      Effect.suspend(() =>
        activeProtocol === undefined
          ? Effect.fail(new EngineStartError({ reason: "not-registered" }))
          : activeProtocol.engine.start(request),
      );

    const reply: HarnessMcpOperations["reply"] = (grant, content) =>
      Effect.suspend(() =>
        activeProtocol === undefined
          ? Effect.fail(
              new EngineReplyError({ reason: "authority-unavailable" }),
            )
          : activeProtocol.engine.reply(grant, content),
      );

    return {
      operations: Object.freeze({
        ...input.management,
        register,
        start,
        reply,
      }),
      subscriptionChanged: (active) => {
        subscriptionChanges.unsafeOffer(active);
      },
      installHandler: (installed) =>
        Effect.sync(() => {
          handler = installed;
        }),
      runSubscriptions: Queue.take(subscriptionChanges).pipe(
        Effect.flatMap((active) =>
          Effect.sync(() => {
            subscriptionActive = active;
          }).pipe(Effect.zipRight(reconcileListener)),
        ),
        Effect.forever,
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause)
            : Deferred.fail(fatal, runtimeFailure("listener")).pipe(
                Effect.zipRight(Effect.never),
              ),
        ),
      ),
      awaitFailure: Deferred.await(fatal),
      initializeAtStart: (state) =>
        state.kind === "unregistered"
          ? Effect.void
          : initialize(state.agentCard).pipe(
              Effect.mapError(activationRuntimeFailure),
            ),
    };
  });

/** Run all daemon-owned protocol and MCP resources until a supervised failure. */
export const runDaemonRuntime = (
  input: {
    readonly store: EndpointStore;
    readonly bootstrap: DaemonBootstrap;
  },
  dependencies: DaemonRuntimeDependencies = productionDependencies,
): Effect.Effect<never, DaemonRuntimeError, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const management = yield* makeDaemonManagementOperations(input);
    const registration = yield* readDaemonRegistrationState(input).pipe(
      Effect.mapError(() => runtimeFailure("storage")),
    );
    const controller = yield* makeDaemonController({
      ...input,
      management,
      dependencies,
    });
    yield* controller.initializeAtStart(registration);
    const handler = yield* dependencies
      .makeHandler({
        implementation: DAEMON_IMPLEMENTATION,
        operations: controller.operations,
        registrySignerPublicKey:
          input.bootstrap.configuration.registrySignerPublicKey,
        onSubscriptionActiveChange: controller.subscriptionChanged,
      })
      .pipe(Effect.mapError(() => runtimeFailure("storage")));
    yield* controller.installHandler(handler);
    yield* controller.runSubscriptions.pipe(Effect.forkScoped);
    yield* dependencies
      .acquireListener({
        port: input.bootstrap.configuration.mcpPort,
        handler,
      })
      .pipe(Effect.mapError(() => runtimeFailure("listener")));
    return yield* controller.awaitFailure;
  }).pipe(Effect.withSpan("runDaemonRuntime"));
