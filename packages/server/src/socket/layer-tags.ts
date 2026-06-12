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
 * These layer Tag unions bound a handler's residual R-channel so a handler at
 * layer L cannot pull a service that only layer L+1 owns.
 *
 * **Placement.** Each Tag below sits at the lowest layer whose handlers yield
 * it.
 *
 * **Maintenance contract.** Adding a new service Tag is a TWO-step edit
 * that lands in the same PR:
 *   1. Add the Tag to the appropriate alias here, at the lowest layer
 *      that yields it.
 *   2. Update the matching `architectureOptions.layers` rule in the root
 *      `eslint.config.js` so the structural lint and the type system
 *      agree.
 *
 * The two-source-of-truth shape is intentional: it keeps the structural lint
 * and the type system in agreement without a codegen pipeline.
 */
import type {
  ConnectionTag,
  DbTag,
  AuthServiceTag,
  AppAuthServiceTag,
  AgentEndpointResolverTag,
  ConnectionManagerTag,
  NetworkSendServiceTag,
  PresenceServiceTag,
  ContactsServiceTag,
  DispatchAdmissionServiceTag,
  TaskAuthorizationServiceTag,
  MessageServiceTag,
  ConversationServiceTag,
  TaskServiceTag,
  LeaseRegistryTag,
  AppHostTag,
} from "../core/layers.js";

/**
 * Bottom kernel — per-request connection id plus the database handle.
 * Both are infrastructure that every protocol layer may pull. ConnectionTag
 * is provided by the slot body (`defineMiddlewareMethod` /
 * `defineUnauthMethod`) from the dispatch context; DbTag is provided by the
 * dispatcher's `ManagedRuntime` from the configured database
 * `Layer.succeed(DbTag, db)`.
 */
type TransportTags = ConnectionTag | DbTag;

/**
 * Identity-layer allowlist: registration, claim, login, contacts,
 * agent visibility, and contacts.
 */
type IdentityTags = TransportTags | AuthServiceTag;

/**
 * Network-layer allowlist: Connect, presence, outbound routing. The
 * `agentEndpointResolver` is the `AgentId → ConnectionId` multimap
 * (network-conceptual — endpoint resolution is what the network layer
 * DOES, not who owns it). The presence service lives in
 * `network/services/`; its Tag is yielded by the presence handler at
 * `network/handlers/`, which fans out via PresenceService.
 */
type NetworkTags =
  | IdentityTags
  | AgentEndpointResolverTag
  | ConnectionManagerTag
  | NetworkSendServiceTag
  | PresenceServiceTag;

/**
 * Task-layer allowlist: conversations, messages, tasks.
 * Includes `LeaseRegistryTag` (admission gate for `messages/send`
 * dispatch leases — yielded by `messages.handlers.ts`) and
 * `AppAuthServiceTag` (yielded by the Connect handler at
 * `identity/handlers/connect.handlers.ts` on the `appKey` arm). The
 * Connect handler runs at task-tier because its body pulls
 * cross-cutting services spanning network (connections, presence) AND
 * task (conversation resolution for presence fan-out).
 */
type TaskTags =
  | NetworkTags
  | MessageServiceTag
  | ConversationServiceTag
  | TaskServiceTag
  | TaskAuthorizationServiceTag
  | ContactsServiceTag
  | LeaseRegistryTag
  | AppAuthServiceTag;

/**
 * App-layer allowlist: dispatch admission and connected app registration.
 */
export type AppTags = TaskTags | AppHostTag | DispatchAdmissionServiceTag;

// There is no global requirement-tag union: each method's requirements ride its
// own `*AuthMw` proof (server-core `auth-middleware-layers.ts`).
