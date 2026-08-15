/** @file Private lifecycle composition for one registered endpoint daemon. */

import type { Implementation } from "@modelcontextprotocol/server";
import { AgentCard, type VerifiedAgentCard } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import {
  Cause,
  type Context,
  Deferred,
  Effect,
  ExecutionStrategy,
  Exit,
  Queue,
  Schema,
  Scope,
} from "effect";
import type { EndpointStore } from "../endpoint/store.js";
import type { HarnessTurnEvent } from "../harness-runtime.js";
import type { DaemonBootstrap } from "./configuration.js";
import packageJson from "../../package.json" with { type: "json" };
import {
  type EndpointEngine,
  type EngineInitializationError,
  EngineReplyError,
  EngineStartError,
  type EngineTurnFrame,
  type EngineTurnSink,
  EngineTurnWriteError,
  makeEndpointEngine,
} from "../endpoint/engine.js";
import {
  makeRouterWorker,
  type RouterWorker,
  type RouterWorkerInput,
  type RouterWorkerProtocolError,
  type RouterWorkerTransportError,
} from "../endpoint/router-worker.js";
import { acquireHarnessMcpHttpServer } from "../harness-mcp-http.js";
import {
  type HarnessMcpOperations,
  makeHarnessMcpHttpHandler,
} from "../harness-mcp-wire.js";
import {
  DaemonActivationError,
  type DaemonActivationPreparation,
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  finishRegistration,
  type InitializeProtocol,
  prepareDaemonActivation,
  recoverPinnedSenderCards,
} from "./runtime-activation.js";

const DAEMON_IMPLEMENTATION = {
  name: "moltzapd",
  version: packageJson.version,
} satisfies Implementation;

type SubscriptionHandler = Effect.Effect.Success<
  ReturnType<DaemonRuntimeDependencies["makeHandler"]>
>;

/** Closed daemon startup and supervision failure. */
export { DaemonRuntimeError };
/** Replaceable process edges used by focused lifecycle tests. */
export type { DaemonRuntimeDependencies };

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
    state: DaemonActivationPreparation["registration"],
  ) => Effect.Effect<void, DaemonRuntimeError>;
}

const productionDependencies: DaemonRuntimeDependencies = {
  makeWorker: (input) => makeRouterWorker(input),
  makeEngine: makeEndpointEngine,
  makeHandler: makeHarnessMcpHttpHandler,
  acquireListener: ({ port, handler }) =>
    acquireHarnessMcpHttpServer({ port, handler }).pipe(Effect.asVoid),
};

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

interface DaemonControllerInput {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
  readonly management: DaemonActivationPreparation["management"];
  readonly dependencies: DaemonRuntimeDependencies;
}

interface ControllerState {
  activeProtocol?: ActiveProtocol;
  subscriptionActive: boolean;
  listenerScope?: Scope.CloseableScope;
  handler?: SubscriptionHandler;
}

interface ControllerEnvironment {
  readonly input: DaemonControllerInput;
  readonly registry: Context.Tag.Service<typeof Registry>;
  readonly router: Context.Tag.Service<typeof Router>;
  readonly daemonScope: Scope.Scope;
  readonly fatal: Deferred.Deferred<never, DaemonRuntimeError>;
  readonly state: ControllerState;
}

const publishTurnEvent = (
  state: ControllerState,
  event: HarnessTurnEvent,
): Effect.Effect<void, EngineTurnWriteError> =>
  Effect.sync(() => state.handler?.publish(event) === true).pipe(
    Effect.filterOrFail(
      (published) => published,
      () => new EngineTurnWriteError(),
    ),
    Effect.asVoid,
  );

const makeTurnSink = (state: ControllerState): EngineTurnSink => ({
  write: (turn) =>
    encodeTurnEvent(turn).pipe(
      Effect.flatMap((event) => publishTurnEvent(state, event)),
    ),
});

const closeListener = (state: ControllerState): Effect.Effect<void> => {
  const scope = state.listenerScope;
  state.listenerScope = undefined;
  if (scope === undefined) {
    return Effect.void;
  }
  return Scope.close(scope, Exit.void);
};

const retainListenerScope = (
  state: ControllerState,
  scope: Scope.CloseableScope,
): void => {
  state.listenerScope = scope;
};

const reconcileListener = (
  environment: ControllerEnvironment,
  listenerGate: Effect.Semaphore,
  sink: EngineTurnSink,
): Effect.Effect<void, DaemonRuntimeError> =>
  listenerGate.withPermits(1)(
    Effect.gen(function* () {
      const protocol = environment.state.activeProtocol;
      if (!environment.state.subscriptionActive || protocol === undefined) {
        yield* closeListener(environment.state);
        return;
      }
      if (environment.state.listenerScope !== undefined) {
        return;
      }
      const scope = yield* Scope.fork(
        environment.daemonScope,
        ExecutionStrategy.sequential,
      );
      const acquired = yield* protocol.engine
        .acquireTurnSink(sink)
        .pipe(Scope.extend(scope), Effect.exit);
      if (Exit.isFailure(acquired)) {
        yield* Scope.close(scope, acquired);
        return yield* Effect.fail(runtimeFailure("listener"));
      }
      retainListenerScope(environment.state, scope);
    }),
  );

const failFromBackgroundCause = <E>(
  fatal: Deferred.Deferred<never, DaemonRuntimeError>,
  cause: Cause.Cause<E>,
): Effect.Effect<never, E> => {
  if (Cause.isInterruptedOnly(cause)) {
    return Effect.failCause(cause);
  }
  return Deferred.fail(fatal, runtimeFailure("listener")).pipe(
    Effect.zipRight(Effect.never),
  );
};

const superviseBackground = (
  environment: ControllerEnvironment,
  effect: Effect.Effect<never, unknown>,
) =>
  effect.pipe(
    Effect.catchAllCause((cause) =>
      failFromBackgroundCause(environment.fatal, cause),
    ),
    Effect.interruptible,
    Effect.forkIn(environment.daemonScope),
    Effect.asVoid,
  );

const makeWorkerCallbacks = (
  awaitEngine: Effect.Effect<EndpointEngine>,
): RouterWorkerInput["callbacks"] => ({
  pinSenderCard: () => awaitEngine.pipe(Effect.asVoid),
  acceptPayload: (ingress) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.acceptRouterIngress(ingress)),
    ),
  acceptRecoveryPayload: (ingress) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.acceptRecoveryIngress(ingress)),
    ),
  abandonVolatileFolds: (reason) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.abandonVolatileFolds(reason)),
    ),
  recoverCertifiedHistory: (recovery) =>
    awaitEngine.pipe(
      Effect.flatMap((engine) => engine.recoverCertifiedHistory(recovery)),
    ),
});

const acquireProtocolWorker = (
  environment: ControllerEnvironment,
  agentCard: VerifiedAgentCard,
  pinnedSenderCards: readonly VerifiedAgentCard[],
  awaitEngine: Effect.Effect<EndpointEngine>,
) =>
  environment.input.dependencies
    .makeWorker({
      callerAgentId: agentCard.agentId,
      callerAgentCard: agentCard,
      pinnedSenderCards,
      signingAuthority: environment.input.bootstrap.signingAuthority,
      callbacks: makeWorkerCallbacks(awaitEngine),
    })
    .pipe(
      Effect.provideService(Registry, environment.registry),
      Effect.provideService(Router, environment.router),
      Effect.mapError(mapWorkerInitializationError),
    );

const mapEngineInitializationError = (
  error: EngineInitializationError,
): DaemonActivationError =>
  activationFailure(
    error.reason === "identity" ? "representation" : error.reason,
  );

const acquireProtocolEngine = (
  environment: ControllerEnvironment,
  agentCard: VerifiedAgentCard,
  worker: RouterWorker,
) =>
  environment.input.dependencies
    .makeEngine({
      localAgentCard: agentCard,
      signingAuthority: environment.input.bootstrap.signingAuthority,
      registrySignerPublicKey:
        environment.input.bootstrap.configuration.registrySignerPublicKey,
      registry: environment.registry,
      store: environment.input.store,
      routerWorker: worker,
    })
    .pipe(
      Scope.extend(environment.daemonScope),
      Effect.mapError(mapEngineInitializationError),
    );

const checkExistingProtocol = (
  agentCard: VerifiedAgentCard,
  activeProtocol?: ActiveProtocol,
): Effect.Effect<boolean, DaemonActivationError> => {
  if (activeProtocol === undefined) {
    return Effect.succeed(false);
  }
  if (
    activeProtocol.agentCard.agentId !== agentCard.agentId ||
    activeProtocol.agentCard.publicKey.x !== agentCard.publicKey.x
  ) {
    return Effect.fail(activationFailure("representation"));
  }
  return Effect.succeed(true);
};

const retainActiveProtocol = (
  state: ControllerState,
  protocol: ActiveProtocol,
): void => {
  state.activeProtocol = protocol;
};

const initializeProtocol = (
  environment: ControllerEnvironment,
  activationGate: Effect.Semaphore,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
  agentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonActivationError> =>
  activationGate.withPermits(1)(
    Effect.gen(function* () {
      const alreadyActive = yield* checkExistingProtocol(
        agentCard,
        environment.state.activeProtocol,
      );
      if (alreadyActive) {
        return;
      }
      const pinnedSenderCards = yield* recoverPinnedSenderCards({
        store: environment.input.store,
        localAgentCard: agentCard,
        bootstrap: environment.input.bootstrap,
      });
      const engineReady = yield* Deferred.make<EndpointEngine>();
      const awaitEngine = Deferred.await(engineReady);
      const worker = yield* acquireProtocolWorker(
        environment,
        agentCard,
        pinnedSenderCards,
        awaitEngine,
      );
      const engine = yield* acquireProtocolEngine(
        environment,
        agentCard,
        worker,
      );
      retainActiveProtocol(environment.state, { agentCard, worker, engine });
      yield* Deferred.succeed(engineReady, engine);
      yield* superviseBackground(environment, worker.run);
      yield* superviseBackground(environment, engine.runOutbound);
      yield* reconciler.pipe(
        Effect.mapError(() => activationFailure("upstream")),
      );
    }),
  );

const makeRegisterOperation =
  (
    environment: ControllerEnvironment,
    initialize: InitializeProtocol,
  ): HarnessMcpOperations["register"] =>
  (request) =>
    Effect.uninterruptible(
      environment.input.management.register(request).pipe(
        Effect.flatMap((result) =>
          finishRegistration(
            {
              store: environment.input.store,
              bootstrap: environment.input.bootstrap,
              fatal: environment.fatal,
              initialize,
            },
            result,
          ),
        ),
      ),
    );

const makeStartOperation =
  (state: ControllerState): HarnessMcpOperations["start"] =>
  (request) =>
    Effect.suspend(() => {
      const protocol = state.activeProtocol;
      if (protocol === undefined) {
        return Effect.fail(new EngineStartError({ reason: "not-registered" }));
      }
      return protocol.engine.start(request);
    });

const makeReplyOperation =
  (state: ControllerState): HarnessMcpOperations["reply"] =>
  (grant, content) =>
    Effect.suspend(() => {
      const protocol = state.activeProtocol;
      if (protocol === undefined) {
        return Effect.fail(
          new EngineReplyError({ reason: "authority-unavailable" }),
        );
      }
      return protocol.engine.reply(grant, content);
    });

const runSubscriptionChanges = (
  environment: ControllerEnvironment,
  changes: Queue.Queue<boolean>,
  reconciler: Effect.Effect<void, DaemonRuntimeError>,
): Effect.Effect<never, DaemonRuntimeError> =>
  Queue.take(changes).pipe(
    Effect.flatMap((active) =>
      Effect.sync(() => {
        environment.state.subscriptionActive = active;
      }).pipe(Effect.zipRight(reconciler)),
    ),
    Effect.forever,
    Effect.catchAllCause((cause) =>
      failFromBackgroundCause(environment.fatal, cause),
    ),
  );

const initializeAtStart = (
  initialize: InitializeProtocol,
  state: DaemonActivationPreparation["registration"],
): Effect.Effect<void, DaemonRuntimeError> => {
  if (state.kind === "unregistered") {
    return Effect.void;
  }
  return initialize(state.agentCard).pipe(
    Effect.mapError(activationRuntimeFailure),
  );
};

const assembleDaemonController = (input: {
  readonly environment: ControllerEnvironment;
  readonly changes: Queue.Queue<boolean>;
  readonly reconciler: Effect.Effect<void, DaemonRuntimeError>;
  readonly initialize: InitializeProtocol;
}): DaemonController => {
  const register = makeRegisterOperation(input.environment, input.initialize);
  return {
    operations: Object.freeze({
      ...input.environment.input.management,
      register,
      start: makeStartOperation(input.environment.state),
      reply: makeReplyOperation(input.environment.state),
    }),
    subscriptionChanged: (active) => {
      input.changes.unsafeOffer(active);
    },
    installHandler: (handler) =>
      Effect.sync(() => {
        input.environment.state.handler = handler;
      }),
    runSubscriptions: runSubscriptionChanges(
      input.environment,
      input.changes,
      input.reconciler,
    ),
    awaitFailure: Deferred.await(input.environment.fatal),
    initializeAtStart: (state) => initializeAtStart(input.initialize, state),
  };
};

const makeDaemonController = (
  input: DaemonControllerInput,
): Effect.Effect<DaemonController, never, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const router = yield* Router;
    const daemonScope = yield* Scope.Scope;
    const activationGate = yield* Effect.makeSemaphore(1);
    const listenerGate = yield* Effect.makeSemaphore(1);
    const changes = yield* Queue.unbounded<boolean>();
    const fatal = yield* Deferred.make<never, DaemonRuntimeError>();
    const state: ControllerState = {
      subscriptionActive: false,
    };
    const environment: ControllerEnvironment = {
      input,
      registry,
      router,
      daemonScope,
      fatal,
      state,
    };
    const sink = makeTurnSink(state);
    const reconciler = reconcileListener(environment, listenerGate, sink);
    const initialize = (agentCard: VerifiedAgentCard) =>
      initializeProtocol(environment, activationGate, reconciler, agentCard);
    return assembleDaemonController({
      environment,
      changes,
      reconciler,
      initialize,
    });
  });

/**
 * Run all daemon-owned protocol and MCP resources until a supervised failure.
 * @param input Daemon-owned persistence and fixed endpoint configuration.
 * @param input.store Durable endpoint store owned by this daemon process.
 * @param input.bootstrap Validated identity, network, and listener configuration.
 * @param dependencies Replaceable process edges used by focused lifecycle tests.
 * @returns A scoped process effect that ends only when a supervised resource fails.
 */
export const runDaemonRuntime = (
  input: {
    readonly store: EndpointStore;
    readonly bootstrap: DaemonBootstrap;
  },
  dependencies: DaemonRuntimeDependencies = productionDependencies,
): Effect.Effect<never, DaemonRuntimeError, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const preparation = yield* prepareDaemonActivation(input);
    const controller = yield* makeDaemonController({
      ...input,
      management: preparation.management,
      dependencies,
    });
    yield* controller.initializeAtStart(preparation.registration);
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
