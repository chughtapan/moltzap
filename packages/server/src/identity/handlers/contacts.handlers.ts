import { Effect } from "effect";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  InvalidParamsError,
  UnauthorizedError,
  type NotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import type { UserId } from "@moltzap/protocol/identity";
import type { AuthService } from "../../identity/services/auth.service.js";
import { opaquePayload } from "../../network/network-send.js";
import type { RpcMethodRegistry } from "../../transport/context.js";
import type { AgentContext } from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  AuthServiceTag,
  ContactsServiceTag,
  NetworkSendServiceTag,
} from "../../app/layers.js";

const ERR_NEED_OWNER = "Contacts require a claimed agent owner";

const loadOwnerOrFail = (
  ctx: AgentContext,
): Effect.Effect<UserId, UnauthorizedError> =>
  ctx.ownerUserId === null
    ? Effect.fail(new UnauthorizedError({ message: ERR_NEED_OWNER }))
    : Effect.succeed(ctx.ownerUserId);

const fanOut = <D extends NotificationDefinition<string, any>>(
  target: UserId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, AuthServiceTag | NetworkSendServiceTag> =>
  Effect.gen(function* () {
    const authService: AuthService = yield* AuthServiceTag;
    const networkSendService = yield* NetworkSendServiceTag;
    const agentIds = yield* authService.agentsForOwner(target);
    if (agentIds.length === 0) return;
    const frame = definition.encode(params);
    const payload = opaquePayload(JSON.stringify(frame));
    yield* networkSendService.broadcast(agentIds, payload);
  }).pipe(Effect.withSpan("contacts.fanOut"));

export const contactHandlers: RpcMethodRegistry = [
  defineTaskMethod(ContactsList, {
    callablePrincipal: "agent",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const contactService = yield* ContactsServiceTag;
        const owner = yield* loadOwnerOrFail(ctx);
        const { contacts, nextCursor } = yield* contactService
          .list(owner, { limit: params.limit, cursor: params.cursor })
          .pipe(
            // A bad cursor is an invalid client param, not an internal defect.
            Effect.catchTag("InvalidCursor", (err) =>
              Effect.fail(new InvalidParamsError({ message: err.message })),
            ),
          );
        return {
          contacts: [...contacts],
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        };
      }).pipe(Effect.withSpan("contacts.list")),
  }),

  defineTaskMethod(ContactsAdd, {
    callablePrincipal: "agent",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const contactService = yield* ContactsServiceTag;
        const owner = yield* loadOwnerOrFail(ctx);
        const contact = yield* contactService.add(owner, params);
        yield* fanOut(
          params.contactUserId,
          ContactRequestNotificationDefinition,
          { contact },
        );
        return { contact };
      }).pipe(Effect.withSpan("contacts.add")),
  }),

  defineTaskMethod(ContactsAccept, {
    callablePrincipal: "agent",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const contactService = yield* ContactsServiceTag;
        const owner = yield* loadOwnerOrFail(ctx);
        const result = yield* contactService.accept(owner, params.contactId);
        if (result.transitioned) {
          yield* fanOut(
            result.requesterUserId,
            ContactAcceptedNotificationDefinition,
            { contact: result.contact },
          );
        }
        return { contact: result.contact };
      }).pipe(Effect.withSpan("contacts.accept")),
  }),

  defineTaskMethod(ContactsById, {
    callablePrincipal: "agent",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const contactService = yield* ContactsServiceTag;
        const owner = yield* loadOwnerOrFail(ctx);
        const contact = yield* contactService.byId(owner, params.contactId);
        return { contact };
      }).pipe(Effect.withSpan("contacts.byId")),
  }),
];
