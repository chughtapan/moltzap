/** @file Private cluster acquisition and lifecycle boundary. */

import type { AgentName } from "@moltzap/identity";
import { Context, Data, type Effect, type Scope } from "effect";
import type { AgentRuntimeLike } from "../agents/agent.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  RuntimeGatewayOf,
  StartedAgent,
} from "../agents/index.js";
import type { HarvestedFileOutcome } from "../events/core.js";
import type { AttachedEndpoint, NetworkError } from "../network/index.js";

// safer-arch-ignore no-cross-domain-sibling-import: The cluster seam names the roster it prepares and the runtime it starts for each roster entry.

/** Cluster loss that ends a run without exposing its backend. */
export class ClusterError extends Data.TaggedError("ClusterError")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Normalize an implementation failure at a cluster boundary. Error causes
 * contribute their message alone so one operation reads the same way whether
 * the boundary raised a thrown Error or a plain description.
 * @param operation Failed cluster operation.
 * @param cause Implementation failure.
 * @returns Typed cluster failure.
 */
export function clusterError(operation: string, cause: unknown): ClusterError {
  return new ClusterError({
    detail: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

/** One exact roster entry presented to a private cluster implementation. */
export interface Slot<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> {
  readonly name: Name;
  readonly agentName: AgentName;
  readonly runtime: Definitions[Name];
}

/** Platform-owned listener used only by the run-private Router fault proxy. */
export interface RouterFaultProxyPlatform {
  readonly listener: {
    readonly bindHost: string;
    readonly port: number;
    readonly advertisedOrigin?: URL;
  };
}

/** Proxy listener whose endpoint-facing network identity is mandatory. */
export interface AdvertisedRouterFaultProxyPlatform
  extends RouterFaultProxyPlatform {
  readonly listener: RouterFaultProxyPlatform["listener"] & {
    readonly advertisedOrigin: URL;
  };
}

/** One harvest target as the live application answered it. */
export interface HarvestedWorkspaceFile {
  readonly relativePath: string;
  readonly outcome: HarvestedFileOutcome;
}

/** Run-scoped cluster capabilities for one complete society roster. */
export interface Society<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly routerFaultProxy: RouterFaultProxyPlatform;

  readonly acquireAgent: <Name extends Extract<keyof Definitions, string>>(
    input: Slot<Definitions, Name>,
  ) => Effect.Effect<
    StartedAgent<Name, RuntimeGatewayOf<Definitions[Name]>>,
    AgentRosterAcquisitionError<Definitions> | ClusterError,
    Scope.Scope
  >;

  /** Acquires one controller-owned daemon against the run's routed ingress. */
  readonly acquireEndpoint: <const Name extends string>(input: {
    readonly name: Name;
    readonly routerOrigin: URL;
  }) => Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope>;

  /**
   * Reads every harvest target the named agent's application declared, from
   * its live container. Never fails: a file that cannot be read is an
   * outcome, and an agent that declared nothing yields nothing.
   */
  readonly harvestWorkspace: (
    name: Extract<keyof Definitions, string>,
  ) => Effect.Effect<readonly HarvestedWorkspaceFile[]>;

  /** Completes only while the exact acquired roster is ready for dispatch. */
  readonly cohortReady: Effect.Effect<void, ClusterError>;

  /** Fails if run-scoped cluster ownership is lost. */
  readonly failure: Effect.Effect<never, ClusterError>;
}

/** Private cluster factory supplied by an execution Layer. */
export interface ClusterService {
  readonly prepare: <
    Id extends string,
    Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    roster: AgentRoster<Id, Definitions>,
  ) => Effect.Effect<Society<Definitions>, ClusterError, Scope.Scope>;
}

/** Private cluster service required by every simulator execution Layer. */
export class Cluster extends Context.Tag("@moltzap/simulator/Cluster")<
  Cluster,
  ClusterService
>() {}
