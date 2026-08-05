/** @file MoltZap implementation of the simulator router service. */

import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import type { ServerBaseUrl } from "@moltzap/protocol/network";
import {
  RouterProvider,
  type AgentConnection,
  type AttachedEndpoint,
  type EndpointTransport,
  type Router,
  type RouterStopped,
} from "./router.js";
import {
  networkError,
  type NetworkError,
  type NetworkOperation,
} from "./failure.js";
import { makeAgentHandle, makeParticipantHandle } from "./participant.js";
import {
  Cause,
  Context,
  Deferred,
  type Duration,
  Effect,
  Layer,
  Option,
  Ref,
  type Scope,
} from "effect";

/** Configuration for one isolated MoltZap router per simulator run. */
export interface RouterOptions {
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
export interface RouterDriver {
  readonly address: ServerBaseUrl;
  readonly register: (
    name: AgentName,
  ) => Effect.Effect<RouterIdentity, unknown>;
  readonly attachEndpoint: (
    key: AgentKey,
  ) => Effect.Effect<EndpointTransport, unknown, Scope.Scope>;
  readonly stopAndCollect: Effect.Effect<RouterStopped, NetworkError>;
}

/** @internal */
export type RouterDriverAcquirer<Requirements = never> = (
  options: RouterOptions,
) => Effect.Effect<RouterDriver, unknown, Scope.Scope | Requirements>;

/**
 * Driver acquisition installed by whichever mechanism runs the router.
 * @internal
 */
export class RouterOperations extends Context.Tag(
  "@moltzap/simulator/RouterOperations",
)<RouterOperations, RouterDriverAcquirer>() {}

interface RouterRuntime {
  readonly driver: RouterDriver;
  readonly bindings: Ref.Ref<ReadonlyMap<string, BoundIdentity>>;
  readonly bind: Effect.Semaphore;
  readonly stopped: Deferred.Deferred<RouterStopped, NetworkError>;
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

function fail(operation: NetworkOperation, cause: unknown): NetworkError {
  return networkError(
    operation,
    cause instanceof Error ? cause.message : cause,
  );
}

function identityFor(
  runtime: RouterRuntime,
  binding: IdentityBinding,
): Effect.Effect<RouterIdentity, NetworkError> {
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
): Effect.Effect<AgentConnection<Name>, NetworkError, Scope.Scope> {
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
): Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope> {
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
  options: RouterOptions,
  acquireDriver: RouterDriverAcquirer,
): Effect.Effect<Router, NetworkError, Scope.Scope> {
  return Effect.gen(function* () {
    const driver = yield* acquireDriver(options).pipe(
      Effect.mapError((cause) => fail("acquire-router", cause)),
    );
    const runtime: RouterRuntime = {
      driver,
      bindings: yield* Ref.make<ReadonlyMap<string, BoundIdentity>>(new Map()),
      bind: yield* Effect.makeSemaphore(1),
      stopped: yield* Deferred.make<RouterStopped, NetworkError>(),
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
 * Publish the router service over the installed driver acquirer.
 * @param options Startup deadline applied to each router acquisition.
 * @internal
 * @returns A Layer providing the router service.
 */
export function routerProviderLayer(
  options: RouterOptions,
): Layer.Layer<RouterProvider, never, RouterOperations> {
  return Layer.effect(
    RouterProvider,
    Effect.map(RouterOperations, (acquireDriver) => ({
      acquire: acquireRouter(options, acquireDriver),
    })),
  );
}
