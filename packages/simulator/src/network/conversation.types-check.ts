/**
 * @file Type canary: the retained public ConversationAddress is constructible
 * from the caller-minted Client identity and a nonempty simulator participant
 * set, so removing content-free Endpoint.open does not strand Endpoint.socket.
 */

import type { ConversationId } from "@moltzap/client";
import type {
  ConversationAddress,
  ConversationParticipants,
} from "./conversation.js";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

/** Compile-time assertion for the retained address construction path. */
export type ConversationAddressCanary = Assert<
  Equal<
    ConstructorParameters<typeof ConversationAddress>,
    [conversationId: ConversationId, participants: ConversationParticipants]
  >
>;
