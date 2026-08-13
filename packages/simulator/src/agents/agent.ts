/** @file Scoped autonomous-agent runtime contract. */
// safer-arch-ignore no-cross-domain-sibling-import: A runtime contract is defined by what it receives: the ledger's JSON configuration shape and the network's connection and inbound-link types.

import type { AgentName } from "@moltzap/identity";
import { type Effect, Either, Schema } from "effect";
import {
  jsonValue,
  type JsonValue as JsonValueType,
} from "../ledger/schema.js";
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
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
> {
  readonly gateway?: Gateway;
  readonly acquisitionError?: AcquisitionError;
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

/** Router attachment presented to a runtime's private container realization. */
export interface AgentRuntimeInput<Name extends string> {
  readonly agentName: AgentName;
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
 * Public metadata for a runtime whose container realization is owned by its
 * implementation. Platform acquisition is deliberately absent here.
 */
export interface AgentRuntimeDefinition<
  Gateway,
  AcquisitionError = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> {
  readonly [agentRuntimeTypesTypeId]?: AgentRuntimeTypes<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  >;
  readonly name: string;
  readonly configuration: AgentRuntimeConfiguration<ConfigurationSchema>;
}

/** A runtime definition accepted by keyed society rosters. */
export interface AgentRuntime<
  Gateway,
  AcquisitionError = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> extends AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  > {
  readonly [agentRuntimeTypeId]: typeof agentRuntimeTypeId;
  readonly [runtimeConfigurationProjectionTypeId]: JsonValueType;
  readonly [agentRuntimeTypesTypeId]: AgentRuntimeTypes<
    Gateway,
    AcquisitionError,
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

/**
 * Freeze a value and everything reachable from it.
 * @param value Value to freeze in place.
 * @returns The same value, now deeply immutable.
 */
export function deepFreeze<Value>(value: Value): Value {
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
 * Preserve inferred gateway, acquisition error, and configuration types.
 * @param runtime Value supplied to the operation.
 * @returns The immutable runtime definition.
 */
export function defineRuntime<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  >,
): AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> {
  if (runtime.name.length === 0) {
    throw AgentRuntimeDefinitionError.make({
      detail: "a runtime name must not be empty",
    });
  }
  const name = runtime.name;
  const captured = captureConfiguration(runtime.configuration);
  const defined: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> =
    {
      [agentRuntimeTypeId]: agentRuntimeTypeId,
      [runtimeConfigurationProjectionTypeId]: captured.projection,
      [agentRuntimeTypesTypeId]: {},
      name,
      configuration: captured.configuration,
    };
  Object.freeze(defined);
  return defined;
}

/** A runtime application or its native gateway did not become ready. */
export class RuntimeAcquisitionError extends Schema.TaggedError<RuntimeAcquisitionError>()(
  "RuntimeAcquisitionError",
  {
    runtime: Schema.NonEmptyString,
    agent: Schema.NonEmptyString,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.runtime} runtime for "${this.agent}" failed to start: ${this.detail}`;
  }
}
