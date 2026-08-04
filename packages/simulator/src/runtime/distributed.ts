/** @file Private distributed application-container capabilities. */

import type { Effect, Schema, Scope } from "effect";
import {
  defineRuntime,
  type AgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeInput,
  type RunningAgent,
  type RuntimeTermination,
} from "./runtime.js";

/** Digest-pinned image identity accepted by the private container platform. */
export type DistributedContainerImage = `${string}@sha256:${string}`;

/** Platform-owned identities needed to materialize one runtime bootstrap. */
export interface DistributedApplicationSupport {
  readonly supportImage: DistributedContainerImage;
  readonly bootstrapSecretIdentity: string;
}

/** One file whose contents are materialized from the run-scoped Secret. */
export interface DistributedBootstrapFile {
  readonly path: `/${string}`;
  readonly content: string;
  readonly mode: number;
}

/** Secret payload rendered for exactly one application container. */
export interface DistributedBootstrapSecret {
  readonly identity: string;
  readonly supportImage: DistributedContainerImage;
  readonly files: readonly DistributedBootstrapFile[];
}

/** Portable resource request for one application container. */
export interface DistributedApplicationResourceRequest {
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly ephemeralStorageBytes: number;
}

/** Credential-free capacity projection available before router attachment. */
export interface DistributedApplicationReservation {
  readonly image: DistributedContainerImage;
  readonly resources: DistributedApplicationResourceRequest;
}

/** The single application container owned by one roster entry. */
export interface DistributedApplicationContainer {
  readonly image: DistributedContainerImage;
  readonly entrypoint: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
  /** Provider variables requested from the private run-scoped bootstrap Secret. */
  readonly credentialEnvironment?: readonly (
    | "ANTHROPIC_API_KEY"
    | "OPENAI_API_KEY"
  )[];
  readonly ports: readonly number[];
  readonly resources: DistributedApplicationResourceRequest;
}

/** Runtime-owned output contract used before its controller bridge attaches. */
export interface DistributedApplicationReadiness {
  readonly outputIncludes: string;
}

/** Platform observations supplied to a runtime-specific controller bridge. */
export interface DistributedApplicationAttachment {
  readonly endpointUrl: string;
  readonly stopped: Effect.Effect<unknown, unknown>;
  readonly termination: Effect.Effect<RuntimeTermination>;
}

/** One rendered application and its runtime-specific controller bridge. */
export interface DistributedRuntimeApplication<Gateway, AcquisitionError> {
  readonly applicationContainer: DistributedApplicationContainer;
  readonly bootstrapSecret: DistributedBootstrapSecret;
  readonly readiness: DistributedApplicationReadiness;
  readonly attach: (
    attachment: DistributedApplicationAttachment,
  ) => Effect.Effect<RunningAgent<Gateway>, AcquisitionError, Scope.Scope>;
}

/** Private distributed realization associated with one exact runtime value. */
export interface DistributedRuntimeCapability<Gateway, AcquisitionError> {
  readonly reservation: DistributedApplicationReservation;
  readonly render: <Name extends string>(
    input: AgentRuntimeInput<Name>,
    support: DistributedApplicationSupport,
  ) => Effect.Effect<
    DistributedRuntimeApplication<Gateway, AcquisitionError>,
    AcquisitionError
  >;
}

/** Container realization supplied by one exact runtime implementation. */
export interface DistributedRuntimeDefinition<
  Gateway,
  AcquisitionError = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> extends AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  > {
  readonly reservation: DistributedApplicationReservation;
  readonly render: DistributedRuntimeCapability<
    Gateway,
    AcquisitionError
  >["render"];
}

const distributedCapabilities = new WeakMap<object, unknown>();

/**
 * Associate one exact frozen runtime value with its private distributed
 * realization. The side table keeps copies and structural lookalikes outside
 * the capability boundary.
 * @param runtime Exact runtime value that owns the capability.
 * @param capability Private distributed realization for that runtime.
 * @internal
 */
function registerDistributedRuntimeCapability<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>,
  capability: DistributedRuntimeCapability<
    NoInfer<Gateway>,
    NoInfer<AcquisitionError>
  >,
): void {
  distributedCapabilities.set(runtime, capability);
}

/**
 * Return the distributed realization registered for this exact runtime value.
 * @param runtime Exact runtime value whose capability is requested.
 * @returns The registered capability, if this value owns one.
 * @internal
 */
export function distributedRuntimeCapability<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>,
): DistributedRuntimeCapability<Gateway, AcquisitionError> | undefined {
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- Registration pairs this exact WeakMap key with the same runtime type parameters.
  return distributedCapabilities.get(runtime) as
    | DistributedRuntimeCapability<Gateway, AcquisitionError>
    | undefined;
}

/**
 * Define one runtime and bind its application container and exact bridge in a
 * single operation. This describes no cross-runtime gateway protocol.
 * @param definition Runtime metadata plus its private container realization.
 * @returns The frozen nominal runtime accepted by a society roster.
 */
export function defineDistributedRuntime<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  definition: DistributedRuntimeDefinition<
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
  registerDistributedRuntimeCapability(runtime, {
    reservation: definition.reservation,
    render: definition.render,
  });
  return runtime;
}
