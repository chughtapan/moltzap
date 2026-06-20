/** @file Contact service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";

import { ContactsService } from "./contact.service.js";

export class ContactsServiceTag extends Context.Tag("moltzap/ContactsService")<
  ContactsServiceTag,
  ContactsService
>() {}

export const ContactsServiceLive = Layer.effect(
  ContactsServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new ContactsService(db);
  }).pipe(Effect.withSpan("ContactsServiceLive")),
);
