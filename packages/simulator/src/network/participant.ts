/** @file Nominal simulator network participant identity handles. */

import type { AgentId } from "@moltzap/identity";

const participantHandleTypeId: unique symbol = Symbol(
  "@moltzap/simulator/ParticipantHandle",
);
const participantHandleConstruction: unique symbol = Symbol(
  "@moltzap/simulator/ParticipantHandleConstruction",
);
const agentHandleTypeId: unique symbol = Symbol(
  "@moltzap/simulator/AgentHandle",
);
const agentHandleConstruction: unique symbol = Symbol(
  "@moltzap/simulator/AgentHandleConstruction",
);

/**
 * A network participant identity. The hidden symbol prevents structurally
 * similar identity data from being used as a simulator handle.
 */
export class ParticipantHandle<Name extends string = string> {
  readonly [participantHandleTypeId] = participantHandleTypeId;

  readonly name: Name;
  readonly id: AgentId;

  protected constructor(name: Name, id: AgentId) {
    this.name = name;
    this.id = id;
  }

  static [participantHandleConstruction]<const Name extends string>(
    name: Name,
    id: AgentId,
  ): ParticipantHandle<Name> {
    return new ParticipantHandle(name, id);
  }
}

/**
 * Construct a participant handle at the simulator network boundary.
 * @param name Validated participant name.
 * @param id Identity-issued agent identifier.
 * @returns Nominal participant identity.
 */
export function makeParticipantHandle<const Name extends string>(
  name: Name,
  id: AgentId,
): ParticipantHandle<Name> {
  return Object.freeze(
    ParticipantHandle[participantHandleConstruction](name, id),
  );
}

/** A participant whose autonomous runtime is owned by the run scope. */
// eslint-disable-next-line agent-code-guard/max-non-trivial-classes-per-file -- agent and controlled-participant identities share one simulator handle contract
export class AgentHandle<
  Name extends string = string,
> extends ParticipantHandle<Name> {
  readonly [agentHandleTypeId] = agentHandleTypeId;

  private constructor(name: Name, id: AgentId) {
    super(name, id);
  }

  static [agentHandleConstruction]<const Name extends string>(
    name: Name,
    id: AgentId,
  ): AgentHandle<Name> {
    return new AgentHandle(name, id);
  }
}

/**
 * Construct an agent handle at the simulator network boundary.
 * @param name Validated roster name.
 * @param id Identity-issued agent identifier.
 * @returns Nominal autonomous-agent identity.
 */
export function makeAgentHandle<const Name extends string>(
  name: Name,
  id: AgentId,
): AgentHandle<Name> {
  return Object.freeze(AgentHandle[agentHandleConstruction](name, id));
}
