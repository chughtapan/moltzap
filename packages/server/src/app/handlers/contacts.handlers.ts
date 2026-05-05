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
  type Contact,
  type Static,
} from "@moltzap/protocol";
import { UserId } from "@moltzap/protocol/schemas/primitives";
import type { ContactsService } from "../../services/contact.service.js";
import type { Broadcaster } from "../../ws/broadcaster.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { unauthorized } from "../../runtime/index.js";
import { defineAppMethod } from "./define-method.js";

type BrandedUserId = Static<typeof UserId>;

const ERR_NEED_OWNER = "Contacts require a claimed agent owner";

export function createContactHandlers(deps: {
  contactService: ContactsService;
  broadcaster: Broadcaster;
}): RpcMethodRegistry {
  const { contactService, broadcaster } = deps;

  const fanOutContactRequest = (
    target: BrandedUserId,
    contact: Contact,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const agentIds = yield* contactService.agentsForUser(target);
      const frame = notificationFrame(ContactRequestNotificationDefinition, {
        contact,
      });
      for (const agentId of agentIds) {
        broadcaster.sendToAgent(agentId, frame);
      }
    });

  const fanOutContactAccepted = (
    target: BrandedUserId,
    contact: Contact,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const agentIds = yield* contactService.agentsForUser(target);
      const frame = notificationFrame(ContactAcceptedNotificationDefinition, {
        contact,
      });
      for (const agentId of agentIds) {
        broadcaster.sendToAgent(agentId, frame);
      }
    });

  const owner = (ctxOwner: string | null): BrandedUserId | null =>
    ctxOwner === null ? null : brandUserId(ctxOwner);

  return [
    defineAppMethod(ContactsList, {
      handler: (_params, ctx) =>
        Effect.gen(function* () {
          const ownerId = owner(ctx.ownerUserId);
          if (ownerId === null) {
            return yield* Effect.fail(unauthorized(ERR_NEED_OWNER));
          }
          const contacts = yield* contactService.list(ownerId);
          return { contacts: [...contacts] };
        }),
    }),

    defineAppMethod(ContactsAdd, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const ownerId = owner(ctx.ownerUserId);
          if (ownerId === null) {
            return yield* Effect.fail(unauthorized(ERR_NEED_OWNER));
          }
          const contact = yield* contactService.add(ownerId, {
            contactUserId: params.contactUserId,
            ...(params.relationship !== undefined
              ? { relationship: params.relationship }
              : {}),
          });
          yield* fanOutContactRequest(params.contactUserId, contact);
          return { contact };
        }),
    }),

    defineAppMethod(ContactsAccept, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const ownerId = owner(ctx.ownerUserId);
          if (ownerId === null) {
            return yield* Effect.fail(unauthorized(ERR_NEED_OWNER));
          }
          const contact = yield* contactService.accept(
            ownerId,
            params.contactId,
          );
          // After acceptance, the row is owned by the recipient (caller).
          // Notify the original requester with the inverse view.
          const requesterUserId = contact.contactUserId;
          yield* fanOutContactAccepted(requesterUserId, {
            ...contact,
            contactUserId: ownerId,
          });
          return { contact };
        }),
    }),

    defineAppMethod(ContactsById, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const ownerId = owner(ctx.ownerUserId);
          if (ownerId === null) {
            return yield* Effect.fail(unauthorized(ERR_NEED_OWNER));
          }
          const contact = yield* contactService.byId(ownerId, params.contactId);
          return { contact };
        }),
    }),
  ];
}
