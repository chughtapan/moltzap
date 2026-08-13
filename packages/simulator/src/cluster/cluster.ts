/** @file Private cluster acquisition and lifecycle boundary. */
// safer-arch-ignore no-cross-domain-sibling-import: The cluster seam names the roster it prepares and the router connection it hands each agent.

import type { AgentName } from "@moltzap/identity";
import { Context, Data, type Effect, type Scope } from "effect";
import type { AgentConnection } from "../network/router.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  RuntimeGatewayOf,
} from "../agents/roster.js";
import type { AgentRuntimeLike, RunningAgent } from "../agents/agent.js";

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
  readonly connection: AgentConnection<Name>;
}

/** Run-scoped cluster capabilities for one complete society roster. */
export interface Society<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly acquireAgent: <Name extends Extract<keyof Definitions, string>>(
    input: Slot<Definitions, Name>,
  ) => Effect.Effect<
    RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
    AgentRosterAcquisitionError<Definitions> | ClusterError,
    Scope.Scope
  >;

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
