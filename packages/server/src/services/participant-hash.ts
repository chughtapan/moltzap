// Pure function that computes the deterministic `participant_set_hash` used
// to enforce DM uniqueness via the partial unique index (spec #136, AC 3).
//
// Algorithm (naming only, implementation downstream):
//   sha256(sort(agentIds).join("\n"))
// Output is the 64-char lowercase hex digest, branded as ParticipantSetHash.
// Collision handling: sha256 is assumed collision-resistant for the task
// population; no secondary disambiguation is required.

import type { AgentId, ParticipantSetHash } from "./task.types.js";

export function computeParticipantSetHash(
  agentIds: readonly AgentId[],
): ParticipantSetHash {
  throw new Error("not implemented");
}
