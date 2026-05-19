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
  ParticipantServiceTag,
  TaskServiceTag,
  LeaseRegistryTag,
  SessionValidatorTag,
  AppHostTag,
  AppTmRegistryTag,
} from "../app/layers.js";
import type {
  TmAuthority,
  TaskReadAccess,
  ConversationParticipantAccess,
  ConversationInTask,
  AgentExists,
  AgentInTaskParticipants,
  ContactPolicyAllowsReach,
  TaskActive,
  ConversationNotArchived,
  ValidReplyTarget,
  NoReplyTarget,
  GroupCapacityForCreate,
  MessageSendPermission,
  ConversationCreateAuthorization,
  AddParticipantPermission,
} from "../app/capabilities/index.js";

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
  | ParticipantServiceTag
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

/**
 * Spec E (#601) R-channel capability tags — DELIBERATELY a SIBLING
 * alias, NOT folded into `TaskTags` / `AppTags`.
 *
 * **Why a sibling.** Capability tags are value-carrying authority
 * proofs (`TmAuthority`, `TaskReadAccess`, …, composite
 * `MessageSendPermission`) that handler bodies MUST drain via
 * `Effect.provideServiceEffect(TAG, obtainTAG(...))` before the
 * Effect leaves the handler. Folding them into `TaskTags` would let a
 * handler whose body `yield*`s a capability without providing it
 * satisfy the `Reqs extends TaskTags` constraint at the
 * `defineTaskMethod` call site, compile cleanly, and panic at runtime
 * when `ManagedRuntime` cannot resolve the unbound capability Tag.
 *
 * Keeping `CapabilityTags` SEPARATE from `TaskTags` preserves
 * Decision A's invariant (architect plan #606 §3): capability tags
 * cannot leak past the wrapper boundary. The
 * `capability-r-channel.types-check.ts` Canary 5 (added r1 per
 * plan-eng-review-606 Finding 2) demonstrates this: a handler that
 * yields `MessageSendPermission` without `provideServiceEffect` fails
 * the `Reqs extends TaskTags` constraint via `@ts-expect-error`.
 *
 * The alias exists for:
 *   - Type-level documentation of the capability surface.
 *   - Re-use inside obtain helpers + the composite `MessageSendPermission`
 *     variant payloads (which may declare `R = CapabilityTags & ...`
 *     when composing layered capabilities).
 *   - Future internal utility types (e.g., `Drain[Reqs, CapabilityTags]`)
 *     that prove a handler's R is empty of capability tags.
 *
 * Phase 1 implement-staff PR adds the concrete `Context.Tag` classes
 * (`TmAuthority`, `TaskReadAccess`, `ConversationParticipantAccess`,
 * `ConversationInTask`, `AgentExists`, `AgentInTaskParticipants`,
 * `ContactPolicyAllowsReach`, `TaskActive`, `ConversationNotArchived`,
 * `ValidReplyTarget`, `NoReplyTarget`, `GroupCapacityForCreate`,
 * `MessageSendPermission`) to this alias. The architect stub leaves
 * the union empty (`never`) — implementations resolve the concrete
 * union when their files land.
 */

/**
 * Concrete capability-tag union (Phase 1, Spec E #601). The thirteen
 * tags enumerated below cover every capability that
 * `packages/server/src/app/capabilities/` exports. New capability tags
 * MUST be added to this union AND to `app/capabilities/index.ts`;
 * absent that, the canary (`capability-r-channel.types-check.ts`) and
 * the `defineTaskMethod` wrapper boundary check cannot recognize the
 * new tag as part of the capability surface, and a handler that fails
 * to drain it would slip past the type system.
 */
export type CapabilityTags =
  | TmAuthority
  | TaskReadAccess
  | ConversationParticipantAccess
  | ConversationInTask
  | AgentExists
  | AgentInTaskParticipants
  | ContactPolicyAllowsReach
  | TaskActive
  | ConversationNotArchived
  | ValidReplyTarget
  | NoReplyTarget
  | GroupCapacityForCreate
  | MessageSendPermission
  | ConversationCreateAuthorization
  | AddParticipantPermission;
