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
import type { NetworkSendService } from "../../network/network-send.js";
import { opaquePayload } from "../../network/network-send.js";
import type {
  AuthenticatedContext,
  RpcMethodRegistry,
} from "../../rpc/context.js";
import { unauthorized, type RpcFailure } from "../../runtime/index.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";

type BrandedUserId = Static<typeof UserId>;

const ERR_NEED_OWNER = "Contacts require a claimed agent owner";

export function createContactHandlers(deps: {
  contactService: ContactsService;
  authService: AuthService;
  networkSendService: NetworkSendService;
}): RpcMethodRegistry {
  const { contactService, authService, networkSendService } = deps;

  const fanOut = <D extends NotificationDefinition<string, TSchema>>(
    target: BrandedUserId,
    definition: D,
    params: NotificationParamsOf<D>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const agentIds = yield* authService.agentsForOwner(target);
      if (agentIds.length === 0) return;
      const frame = notificationFrame(definition, params);
      const payload = opaquePayload(JSON.stringify(frame));
      yield* networkSendService.broadcast(agentIds, payload);
    });

  const requireOwner = (
    ctx: AuthenticatedContext,
  ): Effect.Effect<BrandedUserId, RpcFailure> =>
    ctx.ownerUserId === null
      ? Effect.fail(unauthorized(ERR_NEED_OWNER))
      : Effect.succeed(brandUserId(ctx.ownerUserId));

  return [
    defineTaskMethod(ContactsList, {
      handler: (_params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contacts = yield* contactService.list(owner);
          return { contacts: [...contacts] };
        }),
    }),

    defineTaskMethod(ContactsAdd, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contact = yield* contactService.add(owner, params);
          yield* fanOut(
            params.contactUserId,
            ContactRequestNotificationDefinition,
            { contact },
          );
          return { contact };
        }),
    }),

    defineTaskMethod(ContactsAccept, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const result = yield* contactService.accept(owner, params.contactId);
          if (result.transitioned) {
            yield* fanOut(
              result.requesterUserId,
              ContactAcceptedNotificationDefinition,
              { contact: result.contact },
            );
          }
          return { contact: result.contact };
        }),
    }),

    defineTaskMethod(ContactsById, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const owner = yield* requireOwner(ctx);
          const contact = yield* contactService.byId(owner, params.contactId);
          return { contact };
        }),
    }),
  ];
}
