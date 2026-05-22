import type { Effect } from "effect";
import type { AgentId, UserId } from "../../app/types.js";

/**
 * Result of resolving an app-minted bearer session token. Discriminated
 * union: `valid: true` guarantees `agentId` and `ownerUserId`; `valid:
 * false` carries no payload. `agentStatus` is optional — when present the
 * `network/connect` handler skips a follow-up `SELECT status FROM agents`.
 */
export type SessionValidation =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly agentId: AgentId;
      readonly ownerUserId: UserId;
      readonly agentStatus?: string;
    };

/**
 * Identity-layer contract for app-minted bearer-session validation. The
 * in-process default is unset; `standalone.ts` wires a webhook-backed
 * implementation (`adapters/webhook-session-validator.ts`) when YAML
 * config declares `services.sessions.type: webhook`.
 */
export interface SessionValidator {
  validateSession(token: string): Effect.Effect<SessionValidation, never>;
}
