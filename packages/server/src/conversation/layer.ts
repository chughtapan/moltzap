/** @file Conversation service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { ConnectionManagerTag } from "#socket";
import { AppEndpointRegistryTag } from "#identity/apps";

import { ConversationService } from "./conversation.service.js";

export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}

export const ConversationServiceLive = Layer.effect(
  ConversationServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const connections = yield* ConnectionManagerTag;
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new ConversationService(db, connections, () => {
      const contacts = appEndpointRegistry.getContactService();
      if (!contacts) return null;
      return (a, b) => contacts.areInContact(a, b);
    });
  }).pipe(Effect.withSpan("ConversationServiceLive")),
);
