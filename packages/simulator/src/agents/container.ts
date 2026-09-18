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

/** Every credential a run may hold, in the order the simulator spells them. */
export const CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_AUTH_JSON",
] as const;

/** Provider credential a container may request from the run-scoped Secret. */
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

/** Model provider a credential authenticates against, as a model id prefix spells it. */
type CredentialProvider = "anthropic" | "openai";

/**
 * Who inside a container may spend a credential: any client of the provider's
 * API, or only the unmodified Claude Code binary, the one place Anthropic's
 * terms let a subscription token be used.
 */
export type CredentialConsumer = "provider-client" | "claude-code";

/**
 * How one credential reaches a container. An `environment` credential arrives
 * as the variable of the same name from the run-scoped Secret. A `file`
 * credential is written below the application's `HOME` at `homeRelativePath`,
 * mode 0600, through the same bootstrap path as every other file, because the
 * tool that reads it reads a file and nothing else.
 */
export type CredentialDelivery = {
  readonly provider: CredentialProvider;
  readonly consumer: CredentialConsumer;
} & (
  | { readonly delivery: "environment" }
  | { readonly delivery: "file"; readonly homeRelativePath: string }
);

/**
 * The single description of every credential the simulator carries. The
 * submitter, the controller schema, the cohort, and each runtime derive their
 * view from this table rather than spelling the names again.
 */
export const CREDENTIALS: Readonly<Record<CredentialName, CredentialDelivery>> =
  Object.freeze({
    ANTHROPIC_API_KEY: {
      provider: "anthropic",
      consumer: "provider-client",
      delivery: "environment",
    },
    OPENAI_API_KEY: {
      provider: "openai",
      consumer: "provider-client",
      delivery: "environment",
    },
    CLAUDE_CODE_OAUTH_TOKEN: {
      provider: "anthropic",
      consumer: "claude-code",
      delivery: "environment",
    },
    CODEX_AUTH_JSON: {
      provider: "openai",
      consumer: "provider-client",
      delivery: "file",
      homeRelativePath: ".codex/auth.json",
    },
  });

/**
 * The credentials a model's provider prefix asks for on behalf of one consumer.
 * A model id names its provider ahead of a slash, as OpenClaw spells them
 * (`anthropic/claude-4`); a prefix the table does not know yields nothing
 * rather than a guess, so a container never receives a key it did not need.
 * The cohort forwards whichever of the returned names the run holds and
 * refuses a run holding more than one for the same provider.
 */
export function providerCredentials(
  modelId: string,
  consumer: CredentialConsumer = "provider-client",
): readonly CredentialName[] {
  const [provider] = modelId.split("/", 1);
  return Object.freeze(
    CREDENTIAL_NAMES.filter(
      (name) =>
        CREDENTIALS[name].provider === provider &&
        CREDENTIALS[name].consumer === consumer,
    ),
  );
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
  /**
   * Credentials this application can consume, any one of which is enough.
   * The cluster forwards the ones the run holds and refuses to start the
   * agent when the run holds none of them, or holds two for one provider,
   * since the agent would then run on a credential nobody chose. A
   * file-delivered credential lands under `environment.HOME`, which must be
   * an absolute path. Absent or empty asks for nothing and is never refused.
   */
  readonly credentials?: readonly CredentialName[];
  /** The controller bridge port, and the port whose accept means ready. */
  readonly port: number;
  readonly files: readonly File[];
  /**
   * Files the cluster reads from the live container after the customer
   * program ends, absent when the runtime harvests nothing.
   */
  readonly harvest?: readonly HarvestTarget[];
  readonly logs?: ReadonlyArray<{
    readonly relativePath: string;
    readonly path: string;
  }>;
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
