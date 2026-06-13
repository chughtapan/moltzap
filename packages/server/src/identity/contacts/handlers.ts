import { Effect } from "effect";
import {
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
} from "@moltzap/protocol/identity";
import { InvalidParamsError } from "@moltzap/protocol/rpc";
import type { NotificationParamsOf, ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { UserId } from "@moltzap/protocol/identity";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type { AuthService } from "#identity/agents";
import type { AgentContext } from "#socket";
import {
  AuthServiceTag,
  ContactsServiceTag,
  NetworkSendServiceTag,
} from "#core";
import { agentArm } from "#core";

const fanOut = <D extends AnyNotificationDefinition>(
  target: UserId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, AuthServiceTag | NetworkSendServiceTag> =>
  Effect.gen(function* () {
    const authService: AuthService = yield* AuthServiceTag;
    const networkSendService = yield* NetworkSendServiceTag;
    const agentIds = yield* authService.agentsForOwner(target);
    if (agentIds.length === 0) return;
    yield* networkSendService.broadcastNotification(
      agentIds,
      definition,
      params,
    );
  }).pipe(Effect.withSpan("contacts.fanOut"));

function contactsListBody(
  params: ParamsOf<typeof ContactsList>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = ctx.ownerUserId;
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
  }).pipe(Effect.withSpan("contacts.list"));
}

function contactsAddBody(
  params: ParamsOf<typeof ContactsAdd>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = ctx.ownerUserId;
    const contact = yield* contactService.add(owner, params);
    yield* fanOut(params.contactUserId, ContactRequestNotificationDefinition, {
      contact,
    });
    return { contact };
  }).pipe(Effect.withSpan("contacts.add"));
}

function contactsAcceptBody(
  params: ParamsOf<typeof ContactsAccept>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = ctx.ownerUserId;
    const result = yield* contactService.accept(owner, params.contactId);
    if (result.transitioned) {
      yield* fanOut(
        result.requesterUserId,
        ContactAcceptedNotificationDefinition,
        { contact: result.contact },
      );
    }
    return { contact: result.contact };
  }).pipe(Effect.withSpan("contacts.accept"));
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

export const contactsList: ServerHandler<typeof ContactsList> = (params) =>
  Effect.gen(function* () {
    return yield* contactsListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("contactsList"));

export const contactsAdd: ServerHandler<typeof ContactsAdd> = (params) =>
  Effect.gen(function* () {
    return yield* contactsAddBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("contactsAdd"));

export const contactsAccept: ServerHandler<typeof ContactsAccept> = (params) =>
  Effect.gen(function* () {
    return yield* contactsAcceptBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("contactsAccept"));
