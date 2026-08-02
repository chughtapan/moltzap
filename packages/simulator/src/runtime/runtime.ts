/** @file Scoped autonomous-agent runtime contract. */

import type { AgentName } from "@moltzap/protocol/identity";
import { type Effect, Either, Schema, type Scope } from "effect";
import { jsonValue, type JsonValue as JsonValueType } from "../ledger/model.js";
import type { InboundLinkStage } from "../network/link.js";
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
  Gateway,
  AcquisitionError,
  Requirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly gateway?: Gateway;
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
 * A ready runtime exposes its principal gateway and one lifecycle observation.
 * Completion of the termination Effect records a fact; customer policy decides
 * whether that fact ends the run.
 */
export interface RunningAgent<Gateway> {
  readonly gateway: Gateway;
  readonly termination: Effect.Effect<RuntimeTermination>;
}

/** Router attachment issued to every autonomous runtime implementation. */
export interface AgentRuntimeInput<Name extends string> {
  readonly agentName: AgentName;
  readonly connection: AgentConnection<Name>;
  /**
   * Scoped acquisition of the stage that applies the run's directed-link
   * policies to this agent's inbound deliveries. An implementation whose agent
   * receives in this process acquires it and wraps the stream it hands the
   * agent; one whose agent receives in another process leaves it unacquired,
   * so link control over that agent fails instead of shaping nothing.
   */
  readonly interceptInbound?: Effect.Effect<
    InboundLinkStage,
    never,
    Scope.Scope
  >;
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
  Gateway,
  AcquisitionError = never,
  Requirements = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> {
  readonly name: string;
  readonly configuration: AgentRuntimeConfiguration<ConfigurationSchema>;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<
    RunningAgent<Gateway>,
    AcquisitionError,
    Scope.Scope | Requirements
  >;
}

/** A runtime definition accepted by keyed society rosters. */
export interface AgentRuntime<
  Gateway,
  AcquisitionError = never,
  Requirements = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> extends AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    Requirements,
    ConfigurationSchema
  > {
  readonly [agentRuntimeTypeId]: typeof agentRuntimeTypeId;
  readonly [runtimeConfigurationProjectionTypeId]: JsonValueType;
  readonly [agentRuntimeTypesTypeId]: AgentRuntimeTypes<
    Gateway,
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
    unknown,
    Schema.Schema.AnyNoContext
  >;
  readonly name: string;
  readonly configuration: AgentRuntimeConfiguration<Schema.Schema.AnyNoContext>;
  acquire<Name extends string>(
    input: AgentRuntimeInput<Name>,
  ): Effect.Effect<RunningAgent<unknown>, unknown, unknown>;
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
  Type extends
    Schema.Schema.Type<ConfigurationSchema> = Schema.Schema.Type<ConfigurationSchema>,
  Encoded = Schema.Schema.Encoded<ConfigurationSchema>,
>(
  configuration: Readonly<{
    schema: ConfigurationSchema & Schema.Schema<Type, Encoded>;
    value: Type;
  }>,
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
    configurationValue(
      Schema.decodeUnknownEither(configuration.schema)(canonicalProjection),
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

/**
 * Read the validated, immutable JSON projection captured at definition time.
 * @param runtime Defined runtime whose projection is required.
 * @returns The runtime configuration encoded as JSON.
 */
export function runtimeConfigurationProjection(
  runtime: AgentRuntimeLike,
): JsonValueType {
  return runtime[runtimeConfigurationProjectionTypeId];
}

/**
 * Preserve inferred gateway, acquisition error, requirement, and configuration
 * types.
 * @param runtime Value supplied to the operation.
 * @returns The immutable runtime definition.
 */
export function defineRuntime<
  Gateway,
  AcquisitionError,
  Requirements,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    Requirements,
    ConfigurationSchema
  >,
): AgentRuntime<Gateway, AcquisitionError, Requirements, ConfigurationSchema> {
  if (runtime.name.length === 0) {
    throw AgentRuntimeDefinitionError.make({
      detail: "a runtime name must not be empty",
    });
  }
  const name = runtime.name;
  const captured = captureConfiguration(runtime.configuration);
  const acquire = runtime.acquire.bind(runtime);
  const defined: AgentRuntime<
    Gateway,
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
