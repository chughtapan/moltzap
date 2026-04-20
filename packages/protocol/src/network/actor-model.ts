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
 *     `default-group`, `app`).
 *
 * `EndpointKind` (here) and `TaskManagerEndpointRegistration.kind` (arch-C) are
 * **independent discriminators on two different tables**, not a refinement
 * relationship. `EndpointKind` distinguishes in-memory network registrations
 * (agent socket vs task-manager endpoint). Arch-C's `TaskManagerEndpointRegistration.kind`
 * discriminates among the three task-manager flavors (`default-dm`,
 * `default-group`, `app`) in the persistent `task_manager_endpoints` table.
 * Neither union refines the other; they are first-class siblings.
 *
 * Reachability — these types are exposed via `@moltzap/protocol/network`
 * (the subpath entry carved out by arch-A). They MUST NOT be re-exported
 * from `packages/protocol/src/index.ts` (the flat barrel). Invariant 18 of
 * spec #135 is load-bearing and binds this slice. A prior arch-F attempt
 * added `export * from "./network/actor-model.js"` to the flat barrel; the
 * negative-canary `.type-test.ts` alongside this file is the compile-time
 * guard against that regression.
 *
 * Stub status — this file is types only. No values, no runtime, no
 * implementation bodies. Every declaration below is the contract downstream
 * slices bind to.
 */

// `EndpointAddress` is declared in arch-A (`packages/protocol/src/network/index.ts`)
// and has exactly one declaration site across the monorepo. Import as a type;
// do NOT redeclare — hard constraint 3 of sub-issue #157.
import type { EndpointAddress } from "./index.js";

/* ── Identity brands (canonical declaration sites) ──────────────────────── */

/**
 * The human principal. Issued by the identity layer; crosses the network
 * boundary only inside `AuthenticatedIdentity.ownerUserId`. Never confused
 * with an `AgentId` — the brand prevents it structurally.
 *
 * Canonical declaration site: this module. New in arch-F.
 */
export type UserId = string & { readonly __brand: "UserId" };

/**
 * An agent actor. Owned by zero-or-one user (see `AuthenticatedIdentity`).
 * Addressable as an endpoint via `EndpointRegistration` where
 * `kind === "agent"`. Distinct from `UserId` at the type level.
 *
 * Canonical declaration site: this module. Arch-C (#142) currently
 * re-declares `AgentId` at `packages/protocol/src/task/task-manager.ts`; a
 * follow-up revision on #142 drops that declaration and imports from here
 * so exactly one nominal `AgentId` exists across the monorepo.
 */
export type AgentId = string & { readonly __brand: "AgentId" };

/* ── Endpoint kind (closed union) ───────────────────────────────────────── */

/**
 * The closed set of endpoint kinds the network layer recognises. The union
 * is exhaustive by construction; adding a kind is an architect-level change
 * (new spec or arch sub-issue), not an implementer-level addition.
 *
 * Task-manager sub-kinds (`default-dm`, `default-group`, `app`) are NOT
 * represented here — they are a separate discriminator on a different
 * table (arch-C's persistent `task_manager_endpoints`). See module docstring
 * for the independence invariant.
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
 *
 * Peer symmetry — neither branch carries an originator, initiator, owner,
 * or role flag at the network layer. Peer symmetry ("multi-agent
 * bidirectional") is encoded by the *absence* of such fields; downstream
 * code that wants per-conversation roles stores them in a task-layer
 * per-conversation record (arch-C), not on the network registration.
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
