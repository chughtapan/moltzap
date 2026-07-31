import type { VerifiedAgentCard } from "./agent-card.js";
import type { AgentId } from "./identity-values.js";
import { Brand } from "effect";

/** Request body and caller identity established by AuthenticatedHttp. */
export type VerifiedAgentRequest = Readonly<{
  readonly callerAgentId: AgentId;
  readonly agentCard: VerifiedAgentCard;
  readonly request: unknown;
}> &
  Brand.Brand<"VerifiedAgentRequest">;

const brandVerifiedAgentRequest = Brand.nominal<VerifiedAgentRequest>();

/**
 * Constructs the private proof after every authentication stage succeeds.
 *
 * @param input Authenticated caller, card, and decoded request.
 * @param input.callerAgentId Identity established by authentication.
 * @param input.agentCard Verified immutable identity card.
 * @param input.request Decoded operation request.
 * @returns An immutable proof for authenticated handlers.
 */
export const makeVerifiedAgentRequest = (input: {
  readonly callerAgentId: AgentId;
  readonly agentCard: VerifiedAgentCard;
  readonly request: unknown;
}): VerifiedAgentRequest =>
  brandVerifiedAgentRequest(Object.freeze({ ...input }));
