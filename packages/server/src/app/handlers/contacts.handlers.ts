import { Effect } from "effect";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  notificationFrame,
  userId as brandUserId,
  type NotificationDefinition,
  type NotificationParamsOf,
  type Static,
  type TSchema,
} from "@moltzap/protocol";
import { UserId } from "@moltzap/protocol/schemas/primitives";
import type { ContactsService } from "../../services/contact.service.js";
import type { AuthService } from "../../services/auth.service.js";
import type { Broadcaster } from "../../ws/broadcaster.js";
import type {
  AuthenticatedContext,
  RpcMethodRegistry,
} from "../../rpc/context.js";
import { unauthorized, type RpcFailure } from "../../runtime/index.js";
import { defineAppMethod } from "../../rpc/define-layered-method.js";

type BrandedUserId = Static<typeof UserId>;

const ERR_NEED_OWNER = "Contacts require a claimed agent owner";

export function createContactHandlers(deps: {
  contactService: ContactsService;
  authService: AuthService;
  broadcaster: Broadcaster;
}): RpcMethodRegistry {
  const { contactService, authService, broadcaster } = deps;

  const fanOut = <D extends NotificationDefinition<string, TSchema>>(
    target: BrandedUserId,
    definition: D,
    params: NotificationParamsOf<D>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const agentIds = yield* authService.agentsForOwner(target);
      const frame = notificationFrame(definition, params);
      for (const agentId of agentIds) {
        broadcaster.sendToAgent(agentId, frame);
      }
    });

  const requireOwner = (
    ctx: AuthenticatedContext,
  ): Effect.Effect<BrandedUserId, RpcFailure> =>
    ctx.ownerUserId === null
      ? Effect.fail(unauthorized(ERR_NEED_OWNER))
      : Effect.succeed(brandUserId(ctx.ownerUserId));

  return [
    defineAppMethod(ContactsList, {
      handler: (_params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contacts = yield* contactService.list(owner);
          return { contacts: [...contacts] };
        }),
    }),

    defineAppMethod(ContactsAdd, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contact = yield* contactService.add(owner, {
            contactUserId: params.contactUserId,
            ...(params.relationship !== undefined
              ? { relationship: params.relationship }
              : {}),
          });
          yield* fanOut(
            params.contactUserId,
            ContactRequestNotificationDefinition,
            { contact },
          );
          return { contact };
        }),
    }),

    defineAppMethod(ContactsAccept, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contact = yield* contactService.accept(owner, params.contactId);
          // Notify the original requester with the inverse view: their row
          // points at the recipient (the caller).
          yield* fanOut(
            contact.contactUserId,
            ContactAcceptedNotificationDefinition,
            { contact: { ...contact, contactUserId: owner } },
          );
          return { contact };
        }),
    }),

    defineAppMethod(ContactsById, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contact = yield* contactService.byId(owner, params.contactId);
          return { contact };
        }),
    }),
  ];
}
