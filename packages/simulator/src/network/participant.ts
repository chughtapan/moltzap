/** @file Nominal network participant identity handles. */

import type { AgentId } from "@moltzap/protocol/identity";

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
 * A router-issued network identity. The hidden symbol prevents structurally
 * similar protocol data from being used as an identity handle.
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
 * Construct a participant handle at a router boundary.
 * @param name Validated participant name.
 * @param id Router-issued identity.
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
// eslint-disable-next-line agent-code-guard/max-non-trivial-classes-per-file -- agent and controlled-participant identities share the same router-issued handle contract
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
 * Construct an agent handle at a router boundary.
 * @param name Validated roster name.
 * @param id Router-issued identity.
 * @returns Nominal autonomous-agent identity.
 */
export function makeAgentHandle<const Name extends string>(
  name: Name,
  id: AgentId,
): AgentHandle<Name> {
  return Object.freeze(AgentHandle[agentHandleConstruction](name, id));
}
