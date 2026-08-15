/** @file Private volatile OpenFloorV1 contention and action-admission contracts. */

import type {
  AgentSigningAuthority,
  SignedMessage,
  VerifiedAgentCard,
} from "@moltzap/identity";
import type { Effect } from "effect";
import type {
  EngineProspectiveTurn,
  OpenFloorMulticastCandidate,
} from "./engine-types.js";
import type {
  Begin,
  ClientRepresentationError,
  VerifiedMembership,
} from "./representation.js";
import type { RouterWorkerPersistenceError } from "./router-worker.js";
import type { EndpointStore } from "./store.js";

/** Engine-owned OpenFloor contracts retained at the task boundary. */
export type {
  OpenFloorCertifiedHead,
  OpenFloorMulticastCandidate,
  OpenFloorPort,
} from "./engine-types.js";

/** Engine-owned effects around the task layer's volatile fold. */
export interface OpenFloorActions {
  readonly queueBegin: (
    membership: VerifiedMembership,
    begin: Begin,
  ) => Effect.Effect<void, ClientRepresentationError>;
  readonly queueEvidence: (
    membership: VerifiedMembership,
    evidence: SignedMessage,
  ) => Effect.Effect<void, ClientRepresentationError>;
  readonly onMulticastCandidate: (
    candidate: OpenFloorMulticastCandidate,
  ) => Effect.Effect<void, ClientRepresentationError>;
  readonly deliverTurn: (
    turn: EngineProspectiveTurn,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

/** Private construction input for one endpoint's OpenFloorV1 fold. */
export interface OpenFloorInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
  readonly store: Pick<EndpointStore, "hasConsumedAttention">;
  readonly actions: OpenFloorActions;
  readonly randomBytes?: (size: number) => Uint8Array;
}
