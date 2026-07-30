/** @file Scoped autonomous-agent runtime contract. */

import { type Effect, Either, Schema, type Scope } from "effect";
import { jsonValue, type JsonValue as JsonValueType } from "../ledger/model.js";
import type { AgentConnection } from "../network/router.js";

const agentRuntimeTypeId: unique symbol = Symbol(
  "@moltzap/simulator/AgentRuntime",
);
const runtimeConfigurationProjectionTypeId: unique symbol = Symbol(
  "@moltzap/simulator/RuntimeConfigurationProjection",
);
const agentRuntimeTypesTypeId: unique symbol = Symbol(
  "@moltzap/simulator/AgentRuntimeTypes",
);

interface AgentRuntimeTypes<
  AcquisitionError,
  Requirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly acquisitionError?: AcquisitionError;
  readonly requirements?: Requirements;
  readonly configurationSchema?: ConfigurationSchema;
}

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

/** Runtime-native schema and sanitized configuration captured at definition. */
interface AgentRuntimeConfiguration<
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly schema: ConfigurationSchema;
  readonly value: Schema.Schema.Type<ConfigurationSchema>;
}

/**
 * Scoped acquisition returns only after the runtime is ready. Implementations
 * own runtime-specific configuration and startup deadlines in their
 * constructors and register teardown in the acquisition Scope.
 */
export interface AgentRuntimeDefinition<
  AcquisitionError = never,
  Requirements = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> {
  readonly name: string;
  readonly configuration: AgentRuntimeConfiguration<ConfigurationSchema>;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<RunningAgent, AcquisitionError, Scope.Scope | Requirements>;
}

/** A runtime definition accepted by keyed society rosters. */
export interface AgentRuntime<
  AcquisitionError = never,
  Requirements = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> extends AgentRuntimeDefinition<
    AcquisitionError,
    Requirements,
    ConfigurationSchema
  > {
  readonly [agentRuntimeTypeId]: typeof agentRuntimeTypeId;
  readonly [runtimeConfigurationProjectionTypeId]: JsonValueType;
  readonly [agentRuntimeTypesTypeId]: AgentRuntimeTypes<
    AcquisitionError,
    Requirements,
    ConfigurationSchema
  >;
}

/** Nominal erased runtime type used only to constrain heterogeneous rosters. */
export interface AgentRuntimeLike {
  readonly [agentRuntimeTypeId]: typeof agentRuntimeTypeId;
  readonly [runtimeConfigurationProjectionTypeId]: JsonValueType;
  readonly [agentRuntimeTypesTypeId]: AgentRuntimeTypes<
    unknown,
    unknown,
    Schema.Schema.AnyNoContext
  >;
  readonly name: string;
  readonly configuration: AgentRuntimeConfiguration<Schema.Schema.AnyNoContext>;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<RunningAgent, unknown, unknown>;
}

function invalidConfiguration(detail: string): AgentRuntimeDefinitionError {
  return AgentRuntimeDefinitionError.make({
    detail: `runtime configuration must be Schema-encoded JSON: ${detail}`,
  });
}

function configurationValue<Value>(
  result: Either.Either<Value, unknown>,
): Value {
  return Either.match(result, {
    onLeft: (error) => {
      throw invalidConfiguration(String(error));
    },
    onRight: (value) => value,
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const member of Object.values(value)) {
    deepFreeze(member);
  }
  return Object.freeze(value);
}

function captureConfiguration<
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  configuration: AgentRuntimeConfiguration<ConfigurationSchema>,
): {
  readonly configuration: AgentRuntimeConfiguration<ConfigurationSchema>;
  readonly projection: JsonValueType;
} {
  const encoded = configurationValue(
    Schema.encodeUnknownEither(configuration.schema)(configuration.value),
  );
  const projection = configurationValue(
    Schema.decodeUnknownEither(jsonValue)(encoded),
  );
  const canonicalProjection = deepFreeze(projection);
  const nativeValue = () =>
    deepFreeze(
      configurationValue(
        Schema.decodeUnknownEither(configuration.schema)(canonicalProjection),
      ),
    );
  nativeValue();
  return {
    configuration: Object.freeze({
      schema: configuration.schema,
      get value() {
        return nativeValue();
      },
    }),
    projection: canonicalProjection,
  };
}

/** Encode-free projection used by the kernel after definition validation. */
export function runtimeConfigurationProjection(
  runtime: AgentRuntimeLike,
): JsonValueType {
  return runtime[runtimeConfigurationProjectionTypeId];
}

/**
 * Preserve inferred attachment, error, requirement, and configuration types.
 * @param runtime Value supplied to the operation.
 * @returns The immutable runtime definition.
 */
export function defineRuntime<
  AcquisitionError,
  Requirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntimeDefinition<
    AcquisitionError,
    Requirements,
    ConfigurationSchema
  >,
): AgentRuntime<AcquisitionError, Requirements, ConfigurationSchema> {
  if (runtime.name.length === 0) {
    throw AgentRuntimeDefinitionError.make({
      detail: "a runtime name must not be empty",
    });
  }
  const name = runtime.name;
  const captured = captureConfiguration(runtime.configuration);
  const acquire = runtime.acquire.bind(runtime);
  const defined: AgentRuntime<
    AcquisitionError,
    Requirements,
    ConfigurationSchema
  > = {
    [agentRuntimeTypeId]: agentRuntimeTypeId,
    [runtimeConfigurationProjectionTypeId]: captured.projection,
    [agentRuntimeTypesTypeId]: {},
    name,
    configuration: captured.configuration,
    acquire: <Name extends string>(input: AgentRuntimeInput<Name>) =>
      acquire(input),
  };
  Object.freeze(defined);
  return defined;
}
