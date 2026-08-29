/**
 * @file Type canary: public ConversationAddress construction requires one
 * explicit Client destination and a nonempty simulator participant set.
 */

import type { MessageAddressInput } from "@moltzap/client";
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

/** Compile-time assertion for the public address construction path. */
export type ConversationAddressCanary = Assert<
  Equal<
    ConstructorParameters<typeof ConversationAddress>,
    [destination: MessageAddressInput, participants: ConversationParticipants]
  >
>;
