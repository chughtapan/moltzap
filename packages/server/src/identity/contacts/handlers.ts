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

const fanOut = Effect.fn("contacts.fanOut")(function* <
  D extends AnyNotificationDefinition,
>(target: UserId, definition: D, params: NotificationParamsOf<D>) {
  const authService: AuthService = yield* AuthServiceTag;
  const networkSendService = yield* NetworkSendServiceTag;
  const agentIds = yield* authService.agentsForOwner(target);
  if (agentIds.length === 0) {
    return;
  }
  yield* networkSendService.broadcastNotification(agentIds, definition, params);
});

const contactsListBody = Effect.fn("contacts.list")(function* (
  params: ParamsOf<typeof contactsListDefinition>,
  ctx: AgentContext,
) {
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
});

const contactsAddBody = Effect.fn("contacts.add")(function* (
  params: ParamsOf<typeof contactsAddDefinition>,
  ctx: AgentContext,
) {
  const contactService = yield* ContactsServiceTag;
  const owner = ctx.ownerUserId;
  const contact = yield* contactService.add(owner, params);
  yield* fanOut(params.contactUserId, contactRequestNotificationDefinition, {
    contact,
  });
  return { contact };
});

const contactsAcceptBody = Effect.fn("contacts.accept")(function* (
  params: ParamsOf<typeof contactsAcceptDefinition>,
  ctx: AgentContext,
) {
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
});

// ── @effect/rpc handler bodies ───────────────────────────────────────

/**
 * Provides the contacts list runtime value.
 * @param params Request payload to process.
 * @returns The contacts list result.
 */
export const contactsList: ServerHandler<typeof contactsListDefinition> =
  Effect.fn("contactsList")(function* (params) {
    return yield* contactsListBody(params, yield* agentArm);
  });

/**
 * Provides the contacts add runtime value.
 * @param params Request payload to process.
 * @returns The contacts add result.
 */
export const contactsAdd: ServerHandler<typeof contactsAddDefinition> =
  Effect.fn("contactsAdd")(function* (params) {
    return yield* contactsAddBody(params, yield* agentArm);
  });

/**
 * Provides the contacts accept runtime value.
 * @param params Request payload to process.
 * @returns The contacts accept result.
 */
export const contactsAccept: ServerHandler<typeof contactsAcceptDefinition> =
  Effect.fn("contactsAccept")(function* (params) {
    return yield* contactsAcceptBody(params, yield* agentArm);
  });
