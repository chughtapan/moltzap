/** @file Private in-memory society platform used by kernel tests. */

import { Effect, type Schema, type Scope } from "effect";
import {
  defineRuntime,
  type AgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeInput,
  type AgentRuntimeLike,
  type RunningAgent,
} from "../runtime/runtime.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  RuntimeGatewayOf,
} from "../runtime/roster.js";
import type { SimulatorInfrastructureFailure } from "./failure.js";
import type {
  SocietyAgentAcquisitionInput,
  SocietyPlatformService,
  SocietySession,
} from "./platform.js";

type FakeRuntimeAcquirer<Gateway, AcquisitionError> = <Name extends string>(
  input: AgentRuntimeInput<Name>,
) => Effect.Effect<RunningAgent<Gateway>, AcquisitionError, Scope.Scope>;

const fakeRuntimeAcquirers = new WeakMap<object, unknown>();

/** Runtime metadata plus test-platform acquisition behavior. */
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
 * Define a runtime usable only by the private fake society platform.
 * @param definition Runtime metadata and its test-only acquisition behavior.
 * @returns The nominal runtime registered with the fake platform.
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
  fakeRuntimeAcquirers.set(runtime, definition.acquire);
  return runtime;
}

/**
 * Acquire one exact test runtime through the fake platform side table.
 * @param runtime Exact runtime value previously registered by defineFakeRuntime.
 * @param input Run-scoped agent identity and router connection.
 * @returns The runtime-specific gateway and termination observation.
 */
function acquireFakeRuntime<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
  Name extends string,
>(
  runtime: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<RunningAgent<Gateway>, AcquisitionError, Scope.Scope> {
  const acquire = fakeRuntimeAcquirers.get(runtime);
  if (acquire === undefined) {
    return Effect.dieMessage(
      `runtime "${runtime.name}" has no private fake realization`,
    );
  }
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The exact runtime key is registered together with this acquirer by defineFakeRuntime.
  return (acquire as FakeRuntimeAcquirer<Gateway, AcquisitionError>)(input);
}

/** Lifecycle controls for one private fake society session. */
export interface FakeSocietyPlatformOptions {
  readonly cohortReady?: Effect.Effect<void, SimulatorInfrastructureFailure>;
  readonly failure?: Effect.Effect<never, SimulatorInfrastructureFailure>;
  readonly onAcquire?: (name: string) => Effect.Effect<void>;
  readonly onPrepare?: (names: readonly string[]) => Effect.Effect<void>;
  readonly onRelease?: Effect.Effect<void>;
}

function makeFakeSocietySession<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(options: FakeSocietyPlatformOptions): SocietySession<Definitions> {
  return Object.freeze({
    acquireAgent: <Name extends Extract<keyof Definitions, string>>(
      input: SocietyAgentAcquisitionInput<Definitions, Name>,
    ) =>
      // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The roster maps this exact key to the same runtime gateway and acquisition-error parameters used by acquireFakeRuntime.
      acquireFakeRuntime(input.runtime, {
        agentName: input.agentName,
        connection: input.connection,
      }).pipe(
        Effect.tap(() => options.onAcquire?.(input.name) ?? Effect.void),
      ) as Effect.Effect<
        RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
        AgentRosterAcquisitionError<Definitions>,
        Scope.Scope
      >,
    cohortReady: options.cohortReady ?? Effect.void,
    failure: options.failure ?? Effect.never,
  });
}

/**
 * Build one private platform whose only runtimes come from defineFakeRuntime.
 * @param options Test-controlled readiness, failure, and lifecycle hooks.
 * @returns A private platform service for deterministic kernel tests.
 */
export function makeFakeSocietyPlatform(
  options: FakeSocietyPlatformOptions = {},
): SocietyPlatformService {
  return Object.freeze({
    prepare: <
      Id extends string,
      Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
    >(
      roster: AgentRoster<Id, Definitions>,
    ) => {
      const names = roster.validatedDefinitions.map(({ name }) => name);
      const prepared = options.onPrepare?.(names) ?? Effect.void;
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- SocietyPlatform.prepare returns an Effect requiring Scope, so the kernel owns this release.
      return Effect.acquireRelease(
        prepared.pipe(Effect.as(makeFakeSocietySession<Definitions>(options))),
        () => options.onRelease ?? Effect.void,
      );
    },
  });
}
