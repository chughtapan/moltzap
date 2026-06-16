/**
 * @file Contact-policy contract consumed by `AppEndpointRegistry` to gate cross-user
 * actions (e.g., `TaskCreate.invitedAgentIds` must be in contact with the
 * creator). Distinct from `ContactsService` (the contacts-CRUD class in
 * `contact.service.ts`) — this is the predicate AppEndpointRegistry asks at runtime,
 * and external embedders provide the implementation via
 * `CoreApp.setContactService(...)`.
 *
 * The default in-process implementation is wired via `contact.service.ts`;
 * `webhook-contact-service.ts` (in this folder) provides the
 * webhook-backed variant used by `standalone.ts` when YAML config
 * declares one.
 */

import type { Effect } from "effect";
import type { UserId } from "@moltzap/protocol/identity";

export interface ContactService {
  areInContact(userIdA: UserId, userIdB: UserId): Effect.Effect<boolean, never>;
}
