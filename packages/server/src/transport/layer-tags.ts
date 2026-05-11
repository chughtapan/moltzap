/**
 * Per-layer Tag allowlists. The hierarchy mirrors the protocol layer stack:
 *
 *   transport ─ identity ─ network ─ task ─ app
 *
 * Each layer's allowlist is a superset of the layer below: any Tag legal at
 * layer L is legal at every layer above L. Adding a Tag to a layer's
 * allowlist transitively adds it everywhere above. Placement is determined
 * by the LOWEST layer that yields the Tag in a handler body — placing a
 * Tag higher loses lint signal at lower layers.
 *
 * The `defineXMethod` wrappers in `define-layered-method.ts` use these as
 * generic-constraint upper bounds so a handler at layer L cannot pull a
 * service that only layer L+1 owns.
 *
 * **Audit method.** Each Tag below is placed at the lowest layer whose
 * handlers yield it post-Phase-2A.0 DI migration. The audit ran against
 * `main@adc2e18` handler bodies; result is documented in the Phase 2A r2
 * architect plan §3 ("Handler audit matrix").
 *
 * **Maintenance contract.** Adding a new service Tag is a TWO-step edit
 * that lands in the same PR:
 *   1. Add the Tag to the appropriate alias here, at the lowest layer
 *      that yields it.
 *   2. Update the matching `architectureOptions.layers` rule in the root
 *      `eslint.config.js` so the structural lint and the type system
 *      agree.
 *
 * The two-source-of-truth shape is intentional and named in §10 of the
 * Phase 2A r2 architect plan; the user explicitly accepted the
 * maintenance cost over a codegen pipeline.
 */
import type {
  ConnIdTag,
  DbTag,
  AuthServiceTag,
  AgentEndpointResolverTag,
  ConnectionManagerTag,
  NetworkSendServiceTag,
  PresenceServiceTag,
  ContactsServiceTag,
  MessageServiceTag,
  ConversationServiceTag,
  TaskServiceTag,
  LeaseRegistryTag,
  SessionValidatorTag,
  AppHostTag,
  AppTmRegistryTag,
} from "../app/layers.js";

/**
 * Bottom kernel — per-request connection id plus the database handle.
 * Both are infrastructure that every protocol layer may pull. ConnIdTag
 * is provided by `defineMethod` from the dispatch context; DbTag is
 * provided by the dispatcher's `ManagedRuntime` from the configured
 * database `Layer.succeed(DbTag, db)`.
 */
export type TransportTags = ConnIdTag | DbTag;

/**
 * Identity-layer allowlist: registration, claim, login, contacts,
 * agent-visibility lookups. Yielded by `agents-lookup.handlers.ts` (the
 * three pure-read handlers `AgentsLookup`, `AgentsLookupByName`,
 * `AgentsList` after the auth-handlers split).
 */
export type IdentityTags = TransportTags | AuthServiceTag;

/**
 * Network-layer allowlist: Connect, presence, app-TM dispatch surface.
 * `ping.handlers.ts` lives here. The `agentEndpointResolver` is the
 * `AgentId → ConnectionId` multimap (network-conceptual — endpoint
 * resolution is what the network layer DOES, not who owns it). The
 * presence service lives in `network/services/` post-2A.2 reshape; its
 * Tag is yielded by handlers in higher layers (presence handler routes
 * through the TM bus from `task/handlers/`).
 */
export type NetworkTags =
  | IdentityTags
  | AgentEndpointResolverTag
  | ConnectionManagerTag
  | NetworkSendServiceTag
  | PresenceServiceTag;

/**
 * Task-layer allowlist: conversations, messages, tasks, contacts.
 * Includes `LeaseRegistryTag` (admission gate for `messages/send`
 * dispatch leases — yielded by `messages.handlers.ts`) and
 * `SessionValidatorTag` (yielded by the Connect handler post-split,
 * which lives at `task/handlers/connect.handlers.ts`). The Connect
 * handler is task-tier because its body pulls cross-cutting services
 * spanning network (connections, presence) AND task (conversation
 * resolution for presence fan-out).
 */
export type TaskTags =
  | NetworkTags
  | MessageServiceTag
  | ConversationServiceTag
  | TaskServiceTag
  | ContactsServiceTag
  | LeaseRegistryTag
  | SessionValidatorTag;

/**
 * App-layer allowlist: `apps.handlers.ts` (registration + dispatch
 * authorize). `AppTmRegistryTag` is yielded by the app-host construction
 * path; included here for completeness even though no current handler
 * yields it directly.
 */
export type AppTags = TaskTags | AppHostTag | AppTmRegistryTag;
