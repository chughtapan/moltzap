/** @file Nominal keyed runtime rosters and their exact Effect service. */

import { Context, Schema } from "effect";
import { AgentName } from "@moltzap/protocol/identity";
import type { AgentHandle } from "../network/participant.js";
import type { AgentRuntime, AgentRuntimeLike } from "./runtime.js";

const AgentRosterTypeId: unique symbol = Symbol(
  "@moltzap/simulator/AgentRoster",
);

const rosterDefinitionTokens = new WeakMap<object, object>();

let nextRosterServiceId = 0;

interface ValidatedAgentDefinition {
  readonly name: string;
  readonly agentName: typeof AgentName.Type;
  readonly runtime: AgentRuntimeLike;
}

type RuntimeAcquisitionErrorOf<Runtime> =
  Runtime extends AgentRuntime<infer AcquisitionError, infer _Requirements>
    ? AcquisitionError
    : never;

type RuntimeRequirementsOf<Runtime> =
  Runtime extends AgentRuntime<infer _AcquisitionError, infer Requirements>
    ? Requirements
    : never;

export type AgentRosterAcquisitionError<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = RuntimeAcquisitionErrorOf<Definitions[keyof Definitions]>;

/** The union of every heterogeneous runtime's Effect requirements. */
export type AgentRosterRequirements<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = RuntimeRequirementsOf<Definitions[keyof Definitions]>;

/** Exact keyed handles installed only after every runtime is ready. */
export type StartedAgentHandles<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = Readonly<{
  [Name in Extract<keyof Definitions, string>]: AgentHandle<Name>;
}>;

export interface AgentsService<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly definitionId: Id;
  readonly definitions: Definitions;
}

/**
 * A roster is both the keyed runtime definition and the owner of the exact
 * handles service used by the experiment Effect.
 */
export class AgentRoster<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly [AgentRosterTypeId] = AgentRosterTypeId;

  private constructor(
    readonly definitionId: Id,
    readonly definitions: Definitions,
    readonly validatedDefinitions: ReadonlyArray<ValidatedAgentDefinition>,
    readonly Agents: Context.Tag<
      AgentsService<Id, Definitions>,
      StartedAgentHandles<Definitions>
    >,
  ) {}

  static make<
    const Id extends string,
    const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  >(
    definitionId: Id,
    runtimes: Definitions,
  ): AgentRoster<Id, Definitions> {
    const entries = Object.entries(runtimes);
    const validatedDefinitions = Object.freeze(
      entries.map(([name, runtime]) =>
        Object.freeze({
          name,
          agentName: Schema.decodeUnknownSync(AgentName)(name),
          runtime,
        }),
      ),
    );
    nextRosterServiceId += 1;
    const definitions = Object.freeze(
      Object.fromEntries(entries),
    ) as Definitions;
    const Agents = Context.GenericTag<
      AgentsService<Id, Definitions>,
      StartedAgentHandles<Definitions>
    >(`@moltzap/simulator/Agents/${definitionId}/${nextRosterServiceId}`);
    return Object.freeze(
      new AgentRoster(definitionId, definitions, validatedDefinitions, Agents),
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

/** Bind the roster constructor to one simulator definition. */
export function makeAgentRosterBuilder<const Id extends string>(
  definitionId: Id,
): AgentRosterBuilder<Id> {
  return makeAgentRosterBinding(definitionId).agents;
}
