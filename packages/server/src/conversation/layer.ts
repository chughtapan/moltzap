/** @file Conversation service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { ConnectionManagerTag } from "#socket";

import { ConversationService } from "./conversation.service.js";

/** Implements conversation service tag. */
export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}

/** Provides the conversation service live runtime value. */
export const conversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    return new ConversationService(db, connections);
  }).pipe(Effect.withSpan("ConversationServiceLive")),
);
