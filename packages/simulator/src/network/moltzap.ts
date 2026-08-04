/** @file MoltZap implementation of the simulator router service. */

import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import type { ServerBaseUrl } from "@moltzap/protocol/network";
import {
  type AgentConnection,
  type AttachedEndpoint,
  type EndpointTransport,
  networkFailure,
  type NetworkFailure,
  type NetworkOperation,
  type Router,
  type RouterProviderService,
  type RouterStopped,
} from "./router.js";
import { makeAgentHandle, makeParticipantHandle } from "./participant.js";
import {
  Cause,
  Deferred,
  type Duration,
  Effect,
  Option,
  Ref,
  type Scope,
} from "effect";

/** Configuration for one isolated MoltZap router per simulator run. */
export interface MoltZapRouterOptions {
  readonly startupTimeout: Duration.Duration;
}

interface RouterIdentity {
  readonly agentId: AgentId;
  readonly key: AgentKey;
}

/**
 * The private boundary between router ownership and host resources.
 * It contains neither storage paths nor database row types.
 * @internal
 */
export interface MoltZapRouterDriver {
  readonly address: ServerBaseUrl;
  readonly register: (
    name: AgentName,
  ) => Effect.Effect<RouterIdentity, unknown>;
  readonly attachEndpoint: (
    key: AgentKey,
  ) => Effect.Effect<EndpointTransport, unknown, Scope.Scope>;
  readonly stopAndCollect: Effect.Effect<RouterStopped, NetworkFailure>;
}

/** @internal */
export type MoltZapRouterDriverAcquirer<Requirements = never> = (
  options: MoltZapRouterOptions,
) => Effect.Effect<MoltZapRouterDriver, unknown, Scope.Scope | Requirements>;

interface RouterRuntime {
  readonly driver: MoltZapRouterDriver;
  readonly bindings: Ref.Ref<ReadonlyMap<string, BoundIdentity>>;
  readonly bind: Effect.Semaphore;
  readonly stopped: Deferred.Deferred<RouterStopped, NetworkFailure>;
}

type BindingRole = "agent" | "endpoint";

interface BoundIdentity {
  readonly role: BindingRole;
  readonly identity: RouterIdentity;
}

interface IdentityBinding {
  readonly name: string;
  readonly agentName: AgentName;
  readonly role: BindingRole;
  readonly operation: "attach-agent" | "attach-endpoint";
}

function fail(operation: NetworkOperation, cause: unknown): NetworkFailure {
  return networkFailure(
    operation,
    cause instanceof Error ? cause.message : cause,
  );
}

function identityFor(
  runtime: RouterRuntime,
  binding: IdentityBinding,
): Effect.Effect<RouterIdentity, NetworkFailure> {
  // Registration stays cancellable, but a successful result and its local
  // binding become one masked handoff while the name permit remains held.
  return runtime.bind.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const bindings = yield* Ref.get(runtime.bindings);
        const existing = bindings.get(binding.name);
        if (existing !== undefined) {
          return existing.role === binding.role
            ? existing.identity
            : yield* fail(
                binding.operation,
                `network identity "${binding.name}" is already bound as an ${existing.role}`,
              );
        }
        const identity = yield* restore(
          runtime.driver
            .register(binding.agentName)
            .pipe(Effect.mapError((cause) => fail(binding.operation, cause))),
        );
        yield* Ref.update(runtime.bindings, (current) => {
          const updated = new Map(current);
          updated.set(binding.name, {
            role: binding.role,
            identity,
          });
          return updated;
        });
        return identity;
      }),
    ),
  );
}

function attachAgent<const Name extends string>(
  runtime: RouterRuntime,
  name: Name,
  agentName: AgentName,
): Effect.Effect<AgentConnection<Name>, NetworkFailure, Scope.Scope> {
  return identityFor(runtime, {
    name,
    agentName,
    role: "agent",
    operation: "attach-agent",
  }).pipe(
    Effect.map((identity) => ({
      agent: makeAgentHandle(name, identity.agentId),
      key: identity.key,
      routerUrl: runtime.driver.address,
    })),
  );
}

function attachEndpoint<const Name extends string>(
  runtime: RouterRuntime,
  name: Name,
  agentName: AgentName,
): Effect.Effect<AttachedEndpoint<Name>, NetworkFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const identity = yield* identityFor(runtime, {
      name,
      agentName,
      role: "endpoint",
      operation: "attach-endpoint",
    });
    const transport = yield* runtime.driver
      .attachEndpoint(identity.key)
      .pipe(Effect.mapError((cause) => fail("attach-endpoint", cause)));
    return {
      participant: makeParticipantHandle(name, identity.agentId),
      transport,
    };
  });
}

function completeStopped(runtime: RouterRuntime): Effect.Effect<void> {
  return runtime.driver.stopAndCollect.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const failure = Option.getOrElse(Cause.failureOption(cause), () =>
          fail("stop-router", Cause.pretty(cause)),
        );
        return Deferred.fail(runtime.stopped, failure);
      },
      onSuccess: (stopped) => Deferred.succeed(runtime.stopped, stopped),
    }),
    Effect.asVoid,
  );
}

function acquireRouter(
  options: MoltZapRouterOptions,
  acquireDriver: MoltZapRouterDriverAcquirer,
): Effect.Effect<Router, NetworkFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const driver = yield* acquireDriver(options).pipe(
      Effect.mapError((cause) => fail("acquire-router", cause)),
    );
    const runtime: RouterRuntime = {
      driver,
      bindings: yield* Ref.make<ReadonlyMap<string, BoundIdentity>>(new Map()),
      bind: yield* Effect.makeSemaphore(1),
      stopped: yield* Deferred.make<RouterStopped, NetworkFailure>(),
    };
    yield* Effect.addFinalizer(() => completeStopped(runtime));
    return Object.freeze<Router>({
      address: driver.address,
      stopped: Deferred.await(runtime.stopped),
      attachAgent: (name, agentName) => attachAgent(runtime, name, agentName),
      attachEndpoint: (name, agentName) =>
        attachEndpoint(runtime, name, agentName),
    });
  }).pipe(Effect.withSpan("moltZapRouter.acquire"));
}

/**
 * Construct the MoltZap router provider over an explicit driver acquirer.
 * @param options Options that control the operation.
 * @param acquireDriver Value supplied to the operation.
 * @internal
 * @returns The created molt zap router provider with.
 */
export function makeMoltZapRouterProviderWith(
  options: MoltZapRouterOptions,
  acquireDriver: MoltZapRouterDriverAcquirer,
): RouterProviderService {
  return {
    acquire: acquireRouter(options, acquireDriver),
  };
}
