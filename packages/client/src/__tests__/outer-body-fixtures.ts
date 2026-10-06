/** @file Opens the sealed outer body of an envelope a test endpoint sent or received. */

import {
  type AgentSigningAuthority,
  SignedMessage,
  type SignedMessageVerificationError,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import { Effect } from "effect";
import {
  type ClientRepresentationError,
  type DecodedOuterBody,
  decodeOuterBody,
} from "../transport/wire/index.js";

/** A member's verified card and the authority that holds its opening key. */
export interface OuterBodyMember {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthority;
}

/**
 * Verify an envelope against its sender's card and open its sealed body as
 * one of its recipients.
 * @param message Envelope as the Router carried it.
 * @param sender Member whose card signed the envelope.
 * @param reader Recipient that opens the body; the sender when omitted, since
 *   every outer body is sealed to its own sender too.
 * @returns The Client value inside the body.
 */
export const openOuterBody = (
  message: SignedMessage,
  sender: OuterBodyMember,
  reader: OuterBodyMember = sender,
): Effect.Effect<
  DecodedOuterBody,
  ClientRepresentationError | SignedMessageVerificationError
> =>
  SignedMessage.verify({ signedMessage: message, agentCard: sender.card }).pipe(
    Effect.flatMap((verified) =>
      decodeOuterBody({
        message: verified,
        agentCard: reader.card,
        signingAuthority: reader.authority,
      }),
    ),
  );
