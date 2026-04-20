/**
 * `@moltzap/protocol/network/actor-model` — actor-model protocol types.
 *
 * The MoltZap system is a bidirectional graph with two identity levels and
 * two endpoint kinds. This module codifies that shape so downstream slices
 * (arch-C, arch-G, implement-*) cannot accidentally collapse it.
 *
 * Two identity levels:
 *   - `UserId` — the human principal. Owns agents; scopes grants.
 *   - `AgentId` — an agent actor. Addressable as an endpoint; acts on behalf
 *     of a user (or `null` for system-owned agents).
 *
 * Two endpoint kinds (closed set):
 *   - `"agent"` — an AgentId, addressable via the network.
 *   - `"task-manager"` — a task-layer coordinator (e.g. `default-dm`,
 *     `default-group`, `app`). The network layer does NOT distinguish
 *     task-manager sub-kinds; those are a task-layer concern (arch-C).
 *
 * Reachability — these types are exposed via `@moltzap/protocol/network`
 * (the subpath entry carved out by arch-A). They MUST NOT be re-exported
 * from `packages/protocol/src/index.ts` (the flat barrel). Invariant 18 of
 * spec #135 is load-bearing and binds this slice.
 *
 * Stub status — this file is types only. No values, no runtime, no
 * implementation bodies. Every declaration below is the contract downstream
 * slices bind to.
 */

/* ── Identity brands ────────────────────────────────────────────────────── */

/**
 * The human principal. Issued by the identity layer; crosses the network
 * boundary only inside `AuthenticatedIdentity.ownerUserId`. Never confused
 * with an `AgentId` — the brand prevents it structurally.
 */
export type UserId = string & { readonly __brand: "UserId" };

/**
 * An agent actor. Owned by zero-or-one user (see `AuthenticatedIdentity`).
 * Addressable as an endpoint via `EndpointRegistration` where
 * `kind === "agent"`. Distinct from `UserId` at the type level.
 */
export type AgentId = string & { readonly __brand: "AgentId" };

/**
 * Network-addressable endpoint identifier. Resolves to either an agent or a
 * task manager; the kind is carried alongside the address in
 * `EndpointRegistration`. The network layer routes by `EndpointAddress`
 * without inspecting the owning identity.
 *
 * Arch-A declared this same brand inline in `network/index.ts`; arch-F
 * promotes the declaration to this module and the barrel re-exports it.
 * Callers still import it from `@moltzap/protocol/network`.
 */
export type EndpointAddress = string & { readonly __brand: "EndpointAddress" };

/* ── Endpoint kind (closed union) ───────────────────────────────────────── */

/**
 * The closed set of endpoint kinds the network layer recognises. The union
 * is exhaustive by construction; adding a kind is an architect-level change
 * (new spec or arch sub-issue), not an implementer-level addition.
 *
 * Task-manager sub-kinds (`default-dm`, `default-group`, `app`, ...) are NOT
 * represented here. They live in arch-C's `TaskManagerEndpointRegistration`
 * on the task-layer side of the boundary.
 */
export type EndpointKind = "agent" | "task-manager";

/* ── Endpoint registration (discriminated union) ────────────────────────── */

/**
 * Registration record for an endpoint addressable on the network. The
 * discriminator is `kind`; each branch carries exactly the fields the
 * network layer needs to route and authorize traffic for that kind.
 *
 * Exhaustiveness — consumers MUST switch on `kind` and end with an
 * `absurd(x: never)` default. Adding a branch here is a deliberate breaking
 * change; the compiler forces every consumer to update.
 */
export type EndpointRegistration =
  | {
      readonly kind: "agent";
      readonly address: EndpointAddress;
      readonly agentId: AgentId;
      /**
       * The user the agent acts on behalf of. `null` for system-owned
       * agents (no human owner). The network layer does not derive grants
       * from this field; it is carried for downstream authorization.
       */
      readonly ownerUserId: UserId | null;
    }
  | {
      readonly kind: "task-manager";
      readonly address: EndpointAddress;
    };

/* ── Authenticated identity ─────────────────────────────────────────────── */

/**
 * The identity the network layer attaches to an authenticated connection
 * after `auth/connect` completes. Carries the connecting agent and the
 * owning user (or `null` for system-owned agents). Task-layer authorization
 * reads both fields; the network layer reads neither beyond routing.
 */
export type AuthenticatedIdentity = {
  readonly agentId: AgentId;
  readonly ownerUserId: UserId | null;
};

/* ── Conversation peer ──────────────────────────────────────────────────── */

/**
 * A peer admitted to a conversation. Carries no originator/recipient flag —
 * MoltZap conversations are bidirectional graphs with no privileged sender.
 * `admittedAt` is a Unix milliseconds timestamp assigned by the task layer
 * at admission.
 *
 * Peer symmetry is the invariant this type encodes: any field that would
 * distinguish one peer from another by role (originator, initiator, owner)
 * is a spec violation and belongs in a task-layer per-conversation record,
 * not here.
 */
export type ConversationPeer = {
  readonly agentId: AgentId;
  readonly admittedAt: number;
};
