/** @file Scoped autonomous-agent runtime contract. */

import { type Effect, Schema, type Scope } from "effect";
import type { AgentConnection } from "../network/router.js";

const agentRuntimeTypeId: unique symbol = Symbol(
  "@moltzap/simulator/AgentRuntime",
);

/** Invalid runtime metadata rejected before a run acquires resources. */
export class AgentRuntimeDefinitionError extends Schema.TaggedError<AgentRuntimeDefinitionError>()(
  "AgentRuntimeDefinitionError",
  {
    detail: Schema.NonEmptyString,
  },
) {}

/** An autonomous runtime completed normally. */
export class RuntimeCompleted extends Schema.TaggedClass<RuntimeCompleted>()(
  "RuntimeCompleted",
  {},
) {}

/** An autonomous runtime completed with a recorded failure. */
export class RuntimeFailed extends Schema.TaggedClass<RuntimeFailed>()(
  "RuntimeFailed",
  {
    detail: Schema.String,
  },
) {}

/** A runtime process exited with an operating-system exit code. */
export class RuntimeExited extends Schema.TaggedClass<RuntimeExited>()(
  "RuntimeExited",
  {
    code: Schema.NonNegativeInt,
  },
) {}

/** A runtime process terminated in response to an operating-system signal. */
export class RuntimeSignaled extends Schema.TaggedClass<RuntimeSignaled>()(
  "RuntimeSignaled",
  {
    signal: Schema.NonEmptyString,
  },
) {}

/** Exact terminal observation produced by an acquired runtime. */
export type RuntimeTermination =
  | RuntimeCompleted
  | RuntimeFailed
  | RuntimeExited
  | RuntimeSignaled;

/**
 * The only post-acquisition lifecycle observation. Completion of this Effect
 * records a fact; customer policy decides whether that fact ends the run.
 */
export interface RunningAgent {
  readonly termination: Effect.Effect<RuntimeTermination>;
}

/** Router attachment issued to every autonomous runtime implementation. */
export interface AgentRuntimeInput<Name extends string> {
  readonly connection: AgentConnection<Name>;
}

/**
 * Scoped acquisition returns only after the runtime is ready. Implementations
 * own runtime-specific configuration and startup deadlines in their
 * constructors and register teardown in the acquisition Scope.
 */
export interface AgentRuntimeDefinition<
  AcquisitionError = never,
  Requirements = never,
> {
  readonly name: string;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<RunningAgent, AcquisitionError, Scope.Scope | Requirements>;
}

/** A runtime definition accepted by keyed society rosters. */
export interface AgentRuntime<AcquisitionError = never, Requirements = never>
  extends AgentRuntimeDefinition<AcquisitionError, Requirements> {
  readonly [agentRuntimeTypeId]: typeof agentRuntimeTypeId;
}

/** Nominal erased runtime type used only to constrain heterogeneous rosters. */
export interface AgentRuntimeLike {
  readonly [agentRuntimeTypeId]: typeof agentRuntimeTypeId;
  readonly name: string;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<RunningAgent, unknown, unknown>;
}

/**
 * Preserve inferred attachment, error, and requirement types.
 * @param runtime Value supplied to the operation.
 * @returns The define runtime result.
 */
export function defineRuntime<AcquisitionError, Requirements>(
  runtime: AgentRuntimeDefinition<AcquisitionError, Requirements>,
): AgentRuntime<AcquisitionError, Requirements> {
  if (runtime.name.length === 0) {
    throw AgentRuntimeDefinitionError.make({
      detail: "a runtime name must not be empty",
    });
  }
  const name = runtime.name;
  const acquire = runtime.acquire;
  const defined: AgentRuntime<AcquisitionError, Requirements> = {
    [agentRuntimeTypeId]: agentRuntimeTypeId,
    name,
    acquire: <Name extends string>(input: AgentRuntimeInput<Name>) =>
      acquire(input),
  };
  Object.freeze(defined);
  return defined;
}
