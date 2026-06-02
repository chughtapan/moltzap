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
  type ParamsOf,
} from "@moltzap/protocol";
import type { UserId } from "@moltzap/protocol/identity";
import type { AuthService } from "../../identity/services/auth.service.js";
import type { AgentContext } from "../../transport/context.js";
import {
  AuthServiceTag,
  ContactsServiceTag,
  NetworkSendServiceTag,
} from "../../app/layers.js";
import { agentArm } from "../../app/native-handlers-runtime.js";

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
  }).pipe(Effect.withSpan("contacts.list"));
}

function contactsAddBody(
  params: ParamsOf<typeof ContactsAdd>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = yield* loadOwnerOrFail(ctx);
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
  }).pipe(Effect.withSpan("contacts.accept"));
}

function contactsByIdBody(
  params: ParamsOf<typeof ContactsById>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = yield* loadOwnerOrFail(ctx);
    const contact = yield* contactService.byId(owner, params.contactId);
    return { contact };
  }).pipe(Effect.withSpan("contacts.byId"));
}

// ── Native @effect/rpc handler bodies ───────────────────────────────────────

export const nativeContactsList = (params: ParamsOf<typeof ContactsList>) =>
  Effect.gen(function* () {
    return yield* contactsListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeContactsList"));

export const nativeContactsAdd = (params: ParamsOf<typeof ContactsAdd>) =>
  Effect.gen(function* () {
    return yield* contactsAddBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeContactsAdd"));

export const nativeContactsAccept = (params: ParamsOf<typeof ContactsAccept>) =>
  Effect.gen(function* () {
    return yield* contactsAcceptBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeContactsAccept"));

export const nativeContactsById = (params: ParamsOf<typeof ContactsById>) =>
  Effect.gen(function* () {
    return yield* contactsByIdBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeContactsById"));
