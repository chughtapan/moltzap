/**
 * Per-layer Tag allowlists. The hierarchy mirrors the protocol layer stack:
 *
 *   transport ─ identity ─ network ─ task + conversation + message ─ app.
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
import type { ConnectionTag, ConnectionManagerTag } from "#socket";
import type { DbTag } from "#db";
import type { AuthServiceTag } from "#identity/agents";
import type { AppAuthServiceTag, AppEndpointRegistryTag } from "#identity/apps";
import type { ContactsServiceTag } from "#identity/contacts";
import type { AgentEndpointResolverTag, NetworkSendServiceTag } from "#network";
import type { PresenceServiceTag } from "#network/presence";
import type { ConversationServiceTag } from "#conversation";
import type { DispatchAdmissionServiceTag, LeaseRegistryTag } from "#dispatch";
import type { MessageServiceTag } from "#message";
import type { TaskAuthorizationServiceTag, TaskServiceTag } from "#task";

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
 * Identity-layer allowlist: agent authentication, registration, contacts, and
 * visibility.
 */
type IdentityTags = TransportTags | AuthServiceTag;

/**
 * Network-layer allowlist: connect, presence, and outbound routing. The
 * `agentEndpointResolver` is the `AgentId → ConnectionId` multimap
 * maintained by network connect/disconnect paths. Presence owns the
 * lease-derived status engine.
 */
type NetworkTags =
  | IdentityTags
  | AgentEndpointResolverTag
  | ConnectionManagerTag
  | NetworkSendServiceTag
  | PresenceServiceTag;

/**
 * Task-layer allowlist: conversations, messages, tasks.
 * Includes `LeaseRegistryTag` for message dispatch leases and
 * `AppAuthServiceTag` for the app connect arm. The connect handler runs at
 * this tier because it pulls cross-cutting services spanning network
 * connections/presence and conversation resolution.
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
export type AppTags =
  | TaskTags
  | AppEndpointRegistryTag
  | DispatchAdmissionServiceTag;

// There is no global requirement-tag union: each method's requirements ride its
// own `*AuthMw` proof (server-core `auth-middleware-layers.ts`).
