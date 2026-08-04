/** @file Private society-platform acquisition and lifecycle boundary. */

import type { AgentName } from "@moltzap/protocol/identity";
import { Context, Effect, type Scope } from "effect";
import type { AgentConnection } from "../network/router.js";
import type { SimulatorInfrastructureFailure } from "./failure.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  RuntimeGatewayOf,
} from "../runtime/roster.js";
import type { AgentRuntimeLike, RunningAgent } from "../runtime/runtime.js";

/** One exact roster entry presented to a private platform implementation. */
export interface SocietyAgentAcquisitionInput<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
> {
  readonly name: Name;
  readonly agentName: AgentName;
  readonly runtime: Definitions[Name];
  readonly connection: AgentConnection<Name>;
}

/** Run-scoped platform capabilities for one complete society roster. */
export interface SocietySession<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly acquireAgent: <Name extends Extract<keyof Definitions, string>>(
    input: SocietyAgentAcquisitionInput<Definitions, Name>,
  ) => Effect.Effect<
    RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
    AgentRosterAcquisitionError<Definitions> | SimulatorInfrastructureFailure,
    AgentRosterRequirements<Definitions> | Scope.Scope
  >;

  /** Completes only while the exact acquired roster is ready for dispatch. */
  readonly cohortReady: Effect.Effect<void, SimulatorInfrastructureFailure>;

  /** Fails if run-scoped platform ownership is lost. */
  readonly failure: Effect.Effect<never, SimulatorInfrastructureFailure>;
}

/** Private platform factory supplied by an infrastructure Layer. */
export interface SocietyPlatformService {
  readonly prepare: <
    Id extends string,
    Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    roster: AgentRoster<Id, Definitions>,
  ) => Effect.Effect<
    SocietySession<Definitions>,
    SimulatorInfrastructureFailure,
    Scope.Scope
  >;
}

function acquireDirectAgent<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Name extends Extract<keyof Definitions, string>,
>(
  input: SocietyAgentAcquisitionInput<Definitions, Name>,
): Effect.Effect<
  RunningAgent<RuntimeGatewayOf<Definitions[Name]>>,
  AgentRosterAcquisitionError<Definitions>,
  AgentRosterRequirements<Definitions> | Scope.Scope
> {
  return input.runtime.acquire({
    agentName: input.agentName,
    connection: input.connection,
  });
}

function makeDirectSocietySession<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(roster: AgentRoster<Id, Definitions>): SocietySession<Definitions> {
  return Object.freeze({
    acquireAgent: <Name extends Extract<keyof Definitions, string>>(
      input: SocietyAgentAcquisitionInput<Definitions, Name>,
    ) => acquireDirectAgent(input),
    cohortReady: Effect.succeed(roster.validatedDefinitions).pipe(
      Effect.asVoid,
    ),
    failure: Effect.never,
  });
}

const directSocietyPlatform: SocietyPlatformService = Object.freeze({
  prepare: <
    Id extends string,
    Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    roster: AgentRoster<Id, Definitions>,
  ) => Effect.succeed(makeDirectSocietySession(roster)),
});

/**
 * Private, overridable platform service. The direct default preserves the
 * transitional host path while every execution still crosses this seam.
 */
export class SocietyPlatform extends Context.Reference<SocietyPlatform>()(
  "@moltzap/simulator/SocietyPlatform",
  { defaultValue: () => directSocietyPlatform },
) {}
