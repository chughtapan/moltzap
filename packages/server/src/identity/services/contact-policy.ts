/**
 * @file Contact-policy contract consumed by `AppHost` to gate cross-user
 * actions (e.g., `TaskCreate.invitedAgentIds` must be in contact with the
 * creator). Distinct from `ContactsService` (the contacts-CRUD class in
 * `contact.service.ts`) — this is the predicate AppHost asks at runtime,
 * and external embedders provide the implementation via
 * `CoreApp.setContactService(...)`.
 *
 * The default in-process implementation is wired via `contact.service.ts`;
 * `adapters/webhook-contact-service.ts` provides the webhook-backed
 * variant used by `standalone.ts` when YAML config declares one.
 */

import type { Effect } from "effect";

export interface ContactService {
  areInContact(userIdA: string, userIdB: string): Effect.Effect<boolean, never>;
}
