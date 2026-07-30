import { Effect } from "effect";
import {
  contactAcceptedNotificationDefinition,
  contactRequestNotificationDefinition,
  type contactsAccept as contactsAcceptDefinition,
  type contactsAdd as contactsAddDefinition,
  type contactsList as contactsListDefinition,
  type UserId,
} from "@moltzap/protocol/identity";
import {
  InvalidParamsError,
  type NotificationParamsOf,
  type ParamsOf,
} from "@moltzap/protocol/rpc";
import type {
  ServerHandler,
  AnyNotificationDefinition,
} from "@moltzap/protocol/socket/catalog";
import { AuthServiceTag, type AuthService } from "#identity/agents";
import type { AgentContext } from "#socket";
import { ContactsServiceTag } from "./layer.js";
import { NetworkSendServiceTag } from "#network";
import { agentArm } from "#moltzap/runtime";

const fanOut = <D extends AnyNotificationDefinition>(
  target: UserId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, AuthServiceTag | NetworkSendServiceTag> =>
  Effect.gen(function* () {
    const authService: AuthService = yield* AuthServiceTag;
    const networkSendService = yield* NetworkSendServiceTag;
    const agentIds = yield* authService.agentsForOwner(target);
    if (agentIds.length === 0) {
      return;
    }
    yield* networkSendService.broadcastNotification(
      agentIds,
      definition,
      params,
    );
  }).pipe(Effect.withSpan("contacts.fanOut"));

function contactsListBody(
  params: ParamsOf<typeof contactsListDefinition>,
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
  params: ParamsOf<typeof contactsAddDefinition>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = ctx.ownerUserId;
    const contact = yield* contactService.add(owner, params);
    yield* fanOut(params.contactUserId, contactRequestNotificationDefinition, {
      contact,
    });
    return { contact };
  }).pipe(Effect.withSpan("contacts.add"));
}

function contactsAcceptBody(
  params: ParamsOf<typeof contactsAcceptDefinition>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const contactService = yield* ContactsServiceTag;
    const owner = ctx.ownerUserId;
    const result = yield* contactService.accept(owner, params.contactId);
    if (result.transitioned) {
      yield* fanOut(
        result.requesterUserId,
        contactAcceptedNotificationDefinition,
        { contact: result.contact },
      );
    }
    return { contact: result.contact };
  }).pipe(Effect.withSpan("contacts.accept"));
}

// ── @effect/rpc handler bodies ───────────────────────────────────────

/**
 * Provides the contacts list runtime value.
 * @param params Request payload to process.
 * @returns The contacts list result.
 */
export const contactsList: ServerHandler<typeof contactsListDefinition> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* contactsListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("contactsList"));

/**
 * Provides the contacts add runtime value.
 * @param params Request payload to process.
 * @returns The contacts add result.
 */
export const contactsAdd: ServerHandler<typeof contactsAddDefinition> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* contactsAddBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("contactsAdd"));

/**
 * Provides the contacts accept runtime value.
 * @param params Request payload to process.
 * @returns The contacts accept result.
 */
export const contactsAccept: ServerHandler<typeof contactsAcceptDefinition> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* contactsAcceptBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("contactsAccept"));
