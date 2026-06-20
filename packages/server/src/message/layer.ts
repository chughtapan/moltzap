/** @file Message service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { EncryptionTag } from "#db/crypto";
import { AppEndpointRegistryTag } from "#identity/apps";
import { ConversationServiceTag } from "#conversation";
import { NetworkSendServiceTag } from "#network";

import { MessageAuthorizationService } from "./authorization.js";
import { MessageService } from "./message.service.js";

export class MessageAuthorizationServiceTag extends Context.Tag(
  "moltzap/MessageAuthorizationService",
)<MessageAuthorizationServiceTag, MessageAuthorizationService>() {}

export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}

export const MessageAuthorizationServiceLive = Layer.effect(
  MessageAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    const conversations = yield* ConversationServiceTag;
    return new MessageAuthorizationService(appEndpointRegistry, conversations);
  }).pipe(Effect.withSpan("MessageAuthorizationServiceLive")),
);

export const MessageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    const encryption = yield* EncryptionTag;
    const messageAuthorization = yield* MessageAuthorizationServiceTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
      encryption,
      messageAuthorization,
    });
  }).pipe(Effect.withSpan("MessageServiceLive")),
);
