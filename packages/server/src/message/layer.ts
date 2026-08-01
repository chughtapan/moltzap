/** @file Message service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { EncryptionTag } from "#db/crypto";
import { ConversationServiceTag } from "#conversation";
import { NetworkSendServiceTag } from "#network";

import { MessageService } from "./message.service.js";

/** Implements message service tag. */
export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}

/** Provides the message service live runtime value. */
export const messageServiceLive = Layer.effect(
  MessageServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const networkSend = yield* NetworkSendServiceTag;
    const encryption = yield* EncryptionTag;
    return new MessageService({
      db,
      conversations,
      networkSend,
      encryption,
    });
  }).pipe(Effect.withSpan("MessageServiceLive")),
);
