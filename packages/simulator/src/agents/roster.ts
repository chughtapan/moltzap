/** @file Nominal keyed runtime rosters and their exact Effect service. */
// safer-arch-ignore no-cross-domain-sibling-import: A roster entry pairs a network participant handle with the runtime that answers for it.

import { Context, Schema } from "effect";
import { AgentName as agentName } from "@moltzap/identity";
import type { AgentHandle } from "../network/participant.js";
import type { AgentRuntime, AgentRuntimeLike, RunningAgent } from "./agent.js";

const agentRosterTypeId: unique symbol = Symbol(
  "@moltzap/simulator/AgentRoster",
);

const rosterDefinitionTokens = new WeakMap<object, object>();

let nextRosterServiceId = 0;

type ValidatedAgentDefinition<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = {
  [Name in Extract<keyof Definitions, string>]: Readonly<{
    name: Name;
    agentName: typeof agentName.Type;
    runtime: Definitions[Name];
  }>;
}[Extract<keyof Definitions, string>];

type RuntimeTypesOf<Runtime extends AgentRuntimeLike> =
  Runtime extends AgentRuntime<
    infer Gateway,
    infer AcquisitionError,
    infer ConfigurationSchema
  >
    ? readonly [Gateway, AcquisitionError, ConfigurationSchema]
    : readonly [never, never, never];

type RuntimeAcquisitionErrorOf<Runtime extends AgentRuntimeLike> =
  RuntimeTypesOf<Runtime>[1];

/** The principal gateway exposed by one acquired runtime definition. */
export type RuntimeGatewayOf<Runtime extends AgentRuntimeLike> =
  RuntimeTypesOf<Runtime>[0];

/** Represents agent roster acquisition error conditions. */
export type AgentRosterAcquisitionError<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = RuntimeAcquisitionErrorOf<Definitions[keyof Definitions]>;

/** A ready autonomous runtime paired with its router-issued identity. */
export interface StartedAgent<Name extends string, Gateway>
  extends RunningAgent<Gateway> {
  readonly agent: AgentHandle<Name>;
}

/** Exact keyed agents installed only after every runtime is ready. */
export type StartedAgents<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = Readonly<{
  [Name in Extract<keyof Definitions, string>]: StartedAgent<
    Name,
    RuntimeGatewayOf<Definitions[Name]>
  >;
}>;

/** Describes agents service. */
export interface AgentsService<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly definitionId: Id;
  readonly definitions: Definitions;
}

/**
 * A roster is both the keyed runtime definition and the owner of the exact
 * started-agent service used by the experiment Effect.
 */
export class AgentRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly [agentRosterTypeId] = agentRosterTypeId;

  readonly definitionId: Id;
  readonly definitions: Definitions;
  readonly validatedDefinitions: ReadonlyArray<
    ValidatedAgentDefinition<Definitions>
  >;
  readonly startedAgents: Context.Tag<
    AgentsService<Id, Definitions>,
    StartedAgents<Definitions>
  >;

  private constructor(
    definitionId: Id,
    definitions: Definitions,
    validatedDefinitions: ReadonlyArray<ValidatedAgentDefinition<Definitions>>,
    startedAgents: Context.Tag<
      AgentsService<Id, Definitions>,
      StartedAgents<Definitions>
    >,
  ) {
    this.definitionId = definitionId;
    this.definitions = definitions;
    this.validatedDefinitions = validatedDefinitions;
    this.startedAgents = startedAgents;
  }

  static make<
    const Id extends string,
    const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    definitionId: Id,
    runtimes: Definitions,
  ): AgentRoster<Id, Definitions> {
    const entries = Object.entries(runtimes);
    const validatedDefinitions =
      /* Safe because each own record entry retains its key and indexed runtime value. */ Object.freeze(
        entries.map(([name, runtime]) =>
          Object.freeze({
            name,
            agentName: Schema.decodeUnknownSync(agentName)(name),
            runtime,
          }),
        ),
      ) as ReadonlyArray<ValidatedAgentDefinition<Definitions>>;
    nextRosterServiceId += 1;
    const definitions =
      /* Safe because the surrounding invariant establishes this asserted shape. */ Object.freeze(
        Object.fromEntries(entries),
      ) as Definitions;
    const agentsValue = Context.GenericTag<
      AgentsService<Id, Definitions>,
      StartedAgents<Definitions>
    >(`@moltzap/simulator/Agents/${definitionId}/${nextRosterServiceId}`);
    return Object.freeze(
      new AgentRoster(
        definitionId,
        definitions,
        validatedDefinitions,
        agentsValue,
      ),
    );
  }
}

type AgentRosterBuilder<Id extends string> = <
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(
  runtimes: Definitions,
) => AgentRoster<Id, Definitions>;

/**
 * Construct the roster factory and ownership check for one definition value.
 * The shared token stays inside this closure so equal definition ids cannot
 * make independently constructed definitions interchangeable.
 * @param definitionId Value supplied to the operation.
 * @returns The created agent roster binding.
 */
export function makeAgentRosterBinding<const Id extends string>(
  definitionId: Id,
) {
  const definitionToken = Object.freeze({});
  const agents = <
    const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    runtimes: Definitions,
  ): AgentRoster<Id, Definitions> => {
    const roster = AgentRoster.make(definitionId, runtimes);
    rosterDefinitionTokens.set(roster, definitionToken);
    return roster;
  };
  const owns = <Definitions extends Readonly<Record<string, AgentRuntimeLike>>>(
    roster: AgentRoster<Id, Definitions>,
  ): boolean => rosterDefinitionTokens.get(roster) === definitionToken;

  return Object.freeze({ agents, owns });
}

/**
 * Bind the roster constructor to one simulator definition.
 * @param definitionId Value supplied to the operation.
 * @returns The created agent roster builder.
 */
export function makeAgentRosterBuilder<const Id extends string>(
  definitionId: Id,
): AgentRosterBuilder<Id> {
  return makeAgentRosterBinding(definitionId).agents;
}
