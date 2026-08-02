/**
 * Per-layer Tag allowlists. The hierarchy mirrors the protocol layer stack:
 *
 *   transport ─ identity ─ network ─ conversation + message.
 *
 * Each layer's allowlist is a superset of the layer below: any Tag legal at
 * layer L is legal at every layer above L. Adding a Tag to a layer's
 * allowlist transitively adds it everywhere above. Placement is determined
 * by the LOWEST layer that yields the Tag in a handler body — placing a
 * Tag higher loses lint signal at lower layers.
 *
 * These layer Tag unions bound a handler's residual R-channel so a handler at
 * layer L cannot pull a service that only layer L+1 owns.
 */
import type { ConnectionTag, ConnectionManagerTag } from "#socket";
import type { DbTag } from "#db";
import type { AuthServiceTag } from "#identity/agents";
import type { AgentEndpointResolverTag, NetworkSendServiceTag } from "#network";
import type { ConversationServiceTag } from "#conversation";
import type { MessageServiceTag } from "#message";

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
 * Identity-layer allowlist: agent authentication and registration.
 */
type IdentityTags = TransportTags | AuthServiceTag;

/**
 * Network-layer allowlist: connect and outbound routing. The
 * `agentEndpointResolver` is the `AgentId → ConnectionId` multimap
 * maintained by network connect/disconnect paths.
 */
type NetworkTags =
  | IdentityTags
  | AgentEndpointResolverTag
  | ConnectionManagerTag
  | NetworkSendServiceTag;

/**
 * Top allowlist: conversations and messages. The connect handler runs at this
 * tier because it pulls cross-cutting services spanning network connections
 * and conversation resolution.
 */
export type ServerTags =
  | NetworkTags
  | MessageServiceTag
  | ConversationServiceTag;

// There is no global requirement-tag union: each method's requirements ride its
// own `*AuthMw` proof (server-core `auth-middleware-layers.ts`).
