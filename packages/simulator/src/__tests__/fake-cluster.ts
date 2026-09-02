/** @file Private in-memory cluster used by run tests. */

import type { AgentId, AgentName } from "@moltzap/identity";
import { Effect, type Schema, type Scope } from "effect";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRuntime,
  AgentRuntimeInput,
  RunningAgent,
  RuntimeGatewayOf,
  StartedAgent,
} from "../agents/index.js";
import type {
  ClusterError,
  ClusterService,
  HarvestedWorkspaceFile,
  RouterFaultProxyPlatform,
  Slot,
  Society,
} from "../cluster/cluster.js";
import {
  type AgentRuntimeDefinition,
  type AgentRuntimeLike,
  defineRuntime,
} from "../agents/agent.js";
import {
  type AttachedEndpoint,
  makeAgentHandle,
  type NetworkError,
} from "../network/index.js";

// safer-arch-ignore no-cross-domain-sibling-import: The in-memory cluster mirrors the real seam, so it names the same agent and lifecycle types.

type FakeRuntimeAcquirer<Gateway, AcquisitionError> = (
  input: AgentRuntimeInput,
) => Effect.Effect<RunningAgent<Gateway>, AcquisitionError, Scope.Scope>;

/** Registered, like every other runtime brand, so module copies agree. */
const fakeRuntimeTypeId: unique symbol = Symbol.for(
  "@moltzap/simulator/FakeRuntime",
);

interface FakeRuntimeCarrier<Gateway, AcquisitionError> {
  readonly name: string;
  readonly [fakeRuntimeTypeId]?: FakeRuntimeAcquirer<Gateway, AcquisitionError>;
}

/** Runtime metadata plus test-cluster acquisition behavior. */
export interface FakeRuntimeDefinition<
  Gateway,
  AcquisitionError = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> extends AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  > {
  readonly acquire: FakeRuntimeAcquirer<Gateway, AcquisitionError>;
}

/**
 * Define a runtime usable only by the private fake cluster.
 * @param definition Runtime metadata and its test-only acquisition behavior.
 * @returns The nominal runtime registered with the fake cluster.
 */
export function defineFakeRuntime<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  definition: FakeRuntimeDefinition<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  >,
): AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> {
  const runtime = defineRuntime<Gateway, AcquisitionError, ConfigurationSchema>(
    {
      name: definition.name,
      configuration: definition.configuration,
    },
  );
  // Non-enumerable, matching every other runtime brand: a structural copy of a
  // fake runtime is not the fake runtime.
  const branded: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> =
    Object.freeze(
      Object.defineProperty({ ...runtime }, fakeRuntimeTypeId, {
        value: definition.acquire,
      }),
    );
  return branded;
}

/** Lifecycle controls for one private fake society session. */
export interface FakeClusterOptions {
  /** Identity fixture supplied explicitly by the test that owns the roster. */
  readonly agentIdFor?: (agentName: AgentName) => AgentId;
  readonly acquireEndpoint?: <const Name extends string>(input: {
    readonly name: Name;
    readonly routerOrigin: URL;
  }) => Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope>;
  readonly cohortReady?: Effect.Effect<void, ClusterError>;
  readonly failure?: Effect.Effect<never, ClusterError>;
  /** What each agent's workspace answers when harvested; nothing by default. */
  readonly harvestWorkspace?: (
    name: string,
  ) => Effect.Effect<readonly HarvestedWorkspaceFile[]>;
  readonly onAcquire?: (name: string) => Effect.Effect<void>;
  readonly onPrepare?: (names: readonly string[]) => Effect.Effect<void>;
  readonly onRelease?: Effect.Effect<void>;
  readonly routerFaultProxy?: RouterFaultProxyPlatform;
}

const defaultRouterFaultProxy: RouterFaultProxyPlatform = Object.freeze({
  listener: Object.freeze({ bindHost: "127.0.0.1", port: 0 }),
});

/**
 * Build one private cluster whose only runtimes come from defineFakeRuntime.
 * @param options Test-controlled readiness, failure, and lifecycle hooks.
 * @returns A private cluster service for deterministic run tests.
 */
export function makeFakeCluster(
  options: FakeClusterOptions = {},
): ClusterService {
  return Object.freeze({
    prepare: <
      Id extends string,
      Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
    >(
      roster: AgentRoster<Id, Definitions>,
    ) => {
      const names = roster.validatedDefinitions.map(({ name }) => name);
      const prepared = options.onPrepare?.(names) ?? Effect.void;
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- Cluster.prepare returns an Effect requiring Scope, so the kernel owns this release.
      return Effect.acquireRelease(
        prepared.pipe(Effect.as(makeFakeSociety<Definitions>(options))),
        () => options.onRelease ?? Effect.void,
      );
    },
  });
}

function makeFakeSociety<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(options: FakeClusterOptions): Society<Definitions> {
  return Object.freeze({
    routerFaultProxy: options.routerFaultProxy ?? defaultRouterFaultProxy,
    acquireAgent: <Name extends Extract<keyof Definitions, string>>(
      input: Slot<Definitions, Name>,
    ) =>
      // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The roster maps this exact key to the same runtime gateway and acquisition-error parameters used by acquireFakeRuntime.
      acquireFakeRuntime(input.runtime, {
        agentName: input.agentName,
      }).pipe(
        Effect.tap(() => options.onAcquire?.(input.name) ?? Effect.void),
        Effect.flatMap((running) => {
          const agentId = options.agentIdFor?.(input.agentName);
          return agentId === undefined
            ? Effect.dieMessage(
                `fake cluster requires an explicit AgentId for "${input.agentName}"`,
              )
            : Effect.succeed({
                ...running,
                agent: makeAgentHandle(input.name, agentId),
              });
        }),
      ) as Effect.Effect<
        StartedAgent<Name, RuntimeGatewayOf<Definitions[Name]>>,
        AgentRosterAcquisitionError<Definitions>,
        Scope.Scope
      >,
    acquireEndpoint: <const Name extends string>(input: {
      readonly name: Name;
      readonly routerOrigin: URL;
    }) => {
      const acquire = options.acquireEndpoint;
      return acquire === undefined
        ? Effect.dieMessage(
            `fake cluster has no controlled endpoint acquirer for "${input.name}"`,
          )
        : acquire(input);
    },
    harvestWorkspace: (name: string) =>
      options.harvestWorkspace?.(name) ?? Effect.succeed([]),
    cohortReady: options.cohortReady ?? Effect.void,
    failure: options.failure ?? Effect.never,
  });
}

/**
 * Acquire one test runtime through the acquirer branded onto it.
 * @param runtime Runtime value produced by defineFakeRuntime.
 * @param input Run-scoped roster identity.
 * @returns The runtime-specific gateway and termination observation.
 */
function acquireFakeRuntime<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>,
  input: AgentRuntimeInput,
): Effect.Effect<RunningAgent<Gateway>, AcquisitionError, Scope.Scope> {
  const carrier: FakeRuntimeCarrier<Gateway, AcquisitionError> = runtime;
  const acquire = carrier[fakeRuntimeTypeId];
  if (acquire === undefined) {
    return Effect.dieMessage(
      `runtime "${runtime.name}" has no private fake realization`,
    );
  }
  return acquire(input);
}
