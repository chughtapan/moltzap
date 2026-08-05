/** @file Private container realization owned by one exact agent runtime. */

import { Cause, Effect, Inspectable, type Schema, type Scope } from "effect";
import {
  defineRuntime,
  type AgentRuntime,
  type AgentRuntimeDefinition,
  type AgentRuntimeInput,
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

/** Digest-pinned image identity accepted by the private container platform. */
export type Image = `${string}@sha256:${string}`;

/** Provider credential a container may request from the run-scoped Secret. */
export type CredentialName = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";

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

/** One rendered application and its runtime-specific controller bridge. */
export interface Application<Gateway, AcquisitionError> {
  readonly entrypoint: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
  readonly credentials?: readonly CredentialName[];
  /** The controller bridge port, and the port whose accept means ready. */
  readonly port: number;
  readonly files: readonly File[];
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
    endpoint: URL,
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
  readonly render: <Name extends string>(
    input: AgentRuntimeInput<Name>,
  ) => Effect.Effect<Application<Gateway, AcquisitionError>, AcquisitionError>;
}

interface ContainerRuntimeCarrier<Gateway, AcquisitionError> {
  readonly name: string;
  readonly [containerRuntimeTypeId]?: ContainerRuntime<
    Gateway,
    AcquisitionError
  >;
}

/**
 * Read the container realization branded onto one runtime value.
 * @param runtime Runtime whose container realization is requested.
 * @returns The realization, if this value carries the brand.
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
): AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> {
  const runtime = defineRuntime<Gateway, AcquisitionError, ConfigurationSchema>(
    {
      name: definition.name,
      configuration: definition.configuration,
    },
  );
  // Non-enumerable, so the realization does not travel to structural copies of
  // a runtime, which the cluster would then treat as the runtime itself.
  const branded: AgentRuntime<Gateway, AcquisitionError, ConfigurationSchema> =
    Object.freeze(
      Object.defineProperty({ ...runtime }, containerRuntimeTypeId, {
        value: Object.freeze({
          image: definition.image,
          resources: definition.resources,
          render: definition.render,
        }),
      }),
    );
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
