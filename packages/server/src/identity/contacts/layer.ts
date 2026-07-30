/** @file Contact service tag and live layer. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";

import { ContactsService } from "./contact.service.js";

/** Implements contacts service tag. */
export class ContactsServiceTag extends Context.Tag("moltzap/ContactsService")<
  ContactsServiceTag,
  ContactsService
>() {}

/** Provides the contacts service live runtime value. */
export const contactsServiceLive = Layer.effect(
  ContactsServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new ContactsService(db);
  }).pipe(Effect.withSpan("ContactsServiceLive")),
);
