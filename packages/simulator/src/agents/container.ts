/** @file Private container realization owned by one exact agent runtime. */

import { Cause, Effect, Inspectable, Schema, type Scope } from "effect";
import {
  type AgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeInput,
  defineRuntime,
  RuntimeAcquisitionError,
  type RuntimeTermination,
} from "./agent.js";

/**
 * A registered symbol, not a module-local one. The controller reaches an
 * experiment through a dynamic import, so a runtime is routinely defined in the
 * experiment's module graph and read in the controller's; an unregistered
 * symbol differs between those copies and the brand would be invisible.
 */
const containerRuntimeTypeId: unique symbol = Symbol.for(
  "@moltzap/simulator/ContainerRuntime",
);

/**
 * Digest-pinned image identity accepted by the private container platform.
 * The repository half excludes `@` so a trailing digest cannot be smuggled in
 * behind an earlier one, and the digest is lowercase hexadecimal of exactly the
 * length SHA-256 produces.
 */
export const image = Schema.String.pipe(
  Schema.pattern(/^[^@\s]+@sha256:[\da-f]{64}$/u),
  Schema.brand("Image"),
);

/** Digest-pinned image identity accepted by the private container platform. */
export type Image = typeof image.Type;

/** Provider credential a container may request from the run-scoped Secret. */
export type CredentialName = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";

const CREDENTIAL_BY_PROVIDER: Readonly<Record<string, CredentialName>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * The credential a model's provider prefix asks for, when the run can carry
 * one. A model id names its provider ahead of a slash, as OpenClaw spells
 * them (`anthropic/claude-4`); a prefix the run has no credential for yields
 * nothing rather than a guess, so a container never receives a key it did not
 * need.
 */
export function providerCredential(
  modelId: string,
): CredentialName | undefined {
  const [provider] = modelId.split("/", 1);
  return provider !== undefined &&
    Object.hasOwn(CREDENTIAL_BY_PROVIDER, provider)
    ? CREDENTIAL_BY_PROVIDER[provider]
    : undefined;
}

/** Portable resource request for one application container. */
export interface Resources {
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly ephemeralStorageBytes: number;
}

/** One file materialized into a container from the run-scoped Secret. */
export interface File {
  readonly path: `/${string}`;
  readonly content: string;
  readonly mode: number;
}

/**
 * One file read back from the running application after the customer program
 * ends. `relativePath` is how the ledger names it, `path` is where the runtime
 * placed it inside the container, and `limitBytes` bounds what the ledger
 * carries for it.
 */
export interface HarvestTarget {
  readonly relativePath: string;
  readonly path: `/${string}`;
  readonly limitBytes: number;
}

/**
 * Where the cluster reached one ready application's controller bridge.
 *
 * The cluster builds this from the port the application itself declared, so a
 * runtime reads the address it asked for instead of re-deriving it: a protocol,
 * port, path, or credential the runtime would have to reject cannot be spelled.
 */
export interface ApplicationEndpoint {
  readonly host: string;
  readonly port: number;
}

/** The cluster offered a bridge address a runtime must not connect to. */
class ApplicationEndpointError extends Schema.TaggedError<ApplicationEndpointError>()(
  "ApplicationEndpointError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Loopback answers name the controller's own host rather than the application's
 * Sandbox, so connecting would reach whatever else happens to listen there.
 */
const UNROUTABLE_BRIDGE_HOSTS: ReadonlySet<string> = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/**
 * Refuse a bridge address that never leaves the controller's own host.
 * @param endpoint Address the cluster resolved for a ready application.
 * @returns The same endpoint once it is known to be routable.
 */
export function routableBridgeEndpoint(
  endpoint: ApplicationEndpoint,
): ApplicationEndpoint {
  if (UNROUTABLE_BRIDGE_HOSTS.has(endpoint.host)) {
    throw ApplicationEndpointError.make({
      detail: `an application bridge host must be routable, not "${endpoint.host}"`,
    });
  }
  return endpoint;
}

/**
 * Bind one runtime's name into the failure it reports for its own agents.
 * @param runtime Runtime name recorded on every failure it reports.
 * @returns A builder for that runtime's acquisition failures.
 */
export function acquisitionFailureFor(
  runtime: string,
): (
  agent: string,
  operation: string,
  cause: unknown,
) => RuntimeAcquisitionError {
  return (agent, operation, cause) =>
    RuntimeAcquisitionError.make({
      runtime,
      agent,
      detail: `${operation}: ${String(cause)}`,
    });
}

/** One rendered application and its runtime-specific controller bridge. */
export interface Application<Gateway, AcquisitionError> {
  readonly entrypoint: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
  readonly credentials?: readonly CredentialName[];
  /** The controller bridge port, and the port whose accept means ready. */
  readonly port: number;
  readonly files: readonly File[];
  /**
   * Files the cluster reads from the live container after the customer
   * program ends, absent when the runtime harvests nothing.
   */
  readonly harvest?: readonly HarvestTarget[];
  /**
   * Bind the controller to one ready application.
   *
   * `stopped` is the cluster's own view of the container ending. A runtime that
   * can see a stop the cluster cannot — its controller bridge dying while the
   * container still reports Running — reports it through `reportStopped`; the
   * run records whichever stop is observed first. A runtime with nothing extra
   * to observe accepts fewer arguments and ignores it.
   */
  readonly attach: (
    endpoint: ApplicationEndpoint,
    stopped: Effect.Effect<RuntimeTermination>,
    reportStopped: (termination: RuntimeTermination) => Effect.Effect<void>,
  ) => Effect.Effect<Gateway, AcquisitionError, Scope.Scope>;
}

/**
 * The container realization of one runtime. Image and resources belong here
 * rather than to a rendered application because the cluster reserves capacity
 * for the complete roster before any agent identity exists.
 */
export interface ContainerRuntime<Gateway, AcquisitionError> {
  readonly image: Image;
  readonly resources: Resources;
  readonly render: (
    input: AgentRuntimeInput,
  ) => Effect.Effect<Application<Gateway, AcquisitionError>, AcquisitionError>;
}

/**
 * A runtime that is known to carry a container realization. Only
 * `defineContainerRuntime` produces one, so reading its realization back needs
 * no absent case.
 */
export interface ContainerAgentRuntime<
  Gateway,
  AcquisitionError = never,
  ConfigurationSchema extends
    Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> extends AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> {
  readonly [containerRuntimeTypeId]: ContainerRuntime<
    Gateway,
    AcquisitionError
  >;
}

interface ContainerRuntimeCarrier<Gateway, AcquisitionError> {
  readonly name: string;
  readonly [containerRuntimeTypeId]?: ContainerRuntime<
    Gateway,
    AcquisitionError
  >;
}

export function containerRuntimeFor<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: ContainerAgentRuntime<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  >,
): ContainerRuntime<Gateway, AcquisitionError>;
export function containerRuntimeFor<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>,
): ContainerRuntime<Gateway, AcquisitionError> | undefined;
/**
 * Read the container realization branded onto one runtime value.
 * @param runtime Runtime whose container realization is requested.
 * @returns The realization, absent only for a runtime that never declared one.
 * @internal
 */
export function containerRuntimeFor<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  runtime: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>,
): ContainerRuntime<Gateway, AcquisitionError> | undefined {
  const carrier: ContainerRuntimeCarrier<Gateway, AcquisitionError> = runtime;
  return carrier[containerRuntimeTypeId];
}

/**
 * Define one runtime and bind its container realization in a single operation.
 * This describes no cross-runtime gateway protocol.
 * @param definition Runtime metadata plus its private container realization.
 * @returns The frozen nominal runtime accepted by a society roster.
 */
export function defineContainerRuntime<
  Gateway,
  AcquisitionError,
  ConfigurationSchema extends Schema.Schema.AnyNoContext,
>(
  definition: AgentRuntimeDefinition<
    Gateway,
    AcquisitionError,
    ConfigurationSchema
  > &
    ContainerRuntime<Gateway, AcquisitionError>,
): ContainerAgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> {
  const runtime = defineRuntime<Gateway, AcquisitionError, ConfigurationSchema>(
    {
      name: definition.name,
      configuration: definition.configuration,
    },
  );
  // Non-enumerable, so the realization does not travel to structural copies of
  // a runtime, which the cluster would then treat as the runtime itself.
  const branded =
    /* Safe because the property this asserts was just installed under that exact symbol. */
    Object.freeze(
      Object.defineProperty({ ...runtime }, containerRuntimeTypeId, {
        value: Object.freeze({
          image: definition.image,
          resources: definition.resources,
          render: definition.render,
        }),
      }),
    ) as ContainerAgentRuntime<Gateway, AcquisitionError, ConfigurationSchema>;
  return branded;
}

/**
 * Fail with the runtime's own error the moment its application stops, so a
 * bridge race reports the stop instead of waiting out the startup deadline.
 * The error type is a plain parameter, so each runtime keeps its exact failure
 * channel and no gateway union exists.
 * @param stopped Cluster observation that completes when the application ends.
 * @param onStopped Builds the runtime's error from the printed observation.
 * @returns An Effect that only ever fails.
 */
export function stoppedBeforeAttach<AcquisitionError>(
  stopped: Effect.Effect<RuntimeTermination>,
  onStopped: (detail: string) => AcquisitionError,
): Effect.Effect<never, AcquisitionError> {
  return stopped.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => Effect.fail(onStopped(Cause.pretty(cause))),
      onSuccess: (observation) =>
        Effect.fail(onStopped(Inspectable.stringifyCircular(observation))),
    }),
  );
}
