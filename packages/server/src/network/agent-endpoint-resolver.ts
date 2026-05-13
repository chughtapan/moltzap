/**
 * In-memory `AgentId → HashSet<ConnectionId>` multimap with a paired
 * `ConnectionId → AgentId` reverse index.
 *
 * Plan: `docs/plans/layered-network-refactor-2026-05.md` §2.10 (Slice G1
 * scope), §2.11 (resolver constraint). Issue #426 acceptance.
 *
 * Phase 9b consumer-migration (sub-issue #460 amendment): the legacy
 * `agent-conn` `EndpointAddress` kind retired. Both maps now key on the
 * raw `ConnectionId` because the per-connection address never appeared
 * on the wire — wrapping `connId` as an `EndpointAddress` was internal
 * leakage. `network.send`'s `agent` kind (the only public `EndpointAddress`
 * routing path that reaches this resolver) calls {@link resolveAll}
 * directly to walk the agent's live connection set.
 *
 * Why a multimap. An authenticated agent can hold multiple WebSocket
 * connections (web tab + CLI + mobile). Fan-out has to address every live
 * connection of that agent without re-scanning `ConnectionManager`. The
 * forward map (`HashMap<AgentId, HashSet<ConnectionId>>`) gives O(1)
 * fan-out via {@link AgentEndpointResolver.resolveAll}.
 *
 * Why a paired reverse index. Cross-agent ownership conflict detection
 * (Phase 8 codex deferral on PR #458): if a connection id is already
 * bound to a different agent, the resolver evicts the prior owner from
 * the forward map atomically inside the same {@link Ref.update}.
 * Practically unreachable (connection ids are UUIDs minted at
 * `crypto.randomUUID()` per WS accept), but the detection is cheap and
 * the alternative was a silent forward-map leak.
 *
 * Auth-lifecycle (per §2.11):
 * - Socket connect: NOT yet added to the resolver (no `agentId` known).
 * - `network/connect` success: {@link add} writes the entry atomically.
 * - Disconnect: {@link remove} removes the entry whether the connection
 *   was authed or not (idempotent on never-authed connections).
 *
 * Out of scope for G1:
 * - Cross-process / multi-server scaling. Resolver state is process-local.
 * - TM (`tm:app:`) endpoint registration. {@link NetworkSendService.send}
 *   handles `tm:app:` separately (Phase 9 territory).
 */
import { Effect, HashMap, HashSet, Option, Ref, type Brand } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";

/**
 * Branded type alias for a WebSocket connection id. Resolver internals
 * are pure `ConnectionId → AgentId` lookups; the brand exists so the
 * negative type-test canary at `agent-endpoint-resolver.types-check.ts`
 * can assert that `ConnectionId` is NOT assignable to `EndpointAddress`
 * — closing the surface that pre-Phase-9b leaked the per-connection
 * address through the resolver's public API.
 *
 * The brand is nominal (string-shaped, no UUID predicate) because the
 * caller is `app/server.ts` minting the id via `crypto.randomUUID()`;
 * runtime validation would be redundant. Type-only friction prevents an
 * accidental confusion with `EndpointAddress`.
 */
export type ConnectionId = string & Brand.Brand<"ConnectionId">;

/**
 * Brand a raw connection-id string. Used by the resolver and its callers
 * (`auth.handlers.ts`, `app/server.ts`) so the maps stay strongly typed.
 */
export const connectionId = (raw: string): ConnectionId => raw as ConnectionId;

/**
 * Snapshot of the resolver's combined state. Held in a single {@link Ref}
 * so atomic updates touch both halves at once. Forward and reverse must
 * stay invariant; see module doc.
 */
interface ResolverState {
  readonly byAgent: HashMap.HashMap<AgentId, HashSet.HashSet<ConnectionId>>;
  readonly byConnection: HashMap.HashMap<ConnectionId, AgentId>;
}

const emptyState: ResolverState = {
  byAgent: HashMap.empty<AgentId, HashSet.HashSet<ConnectionId>>(),
  byConnection: HashMap.empty<ConnectionId, AgentId>(),
};

/**
 * Multimap of agent → connection ids, plus a reverse index from
 * connection → agent.
 *
 * All mutators run inside a single {@link Ref.update} so the forward and
 * reverse views never disagree, even under concurrent {@link add} /
 * {@link remove} calls from independent `network/connect` and disconnect
 * fibers.
 */
export class AgentEndpointResolver {
  static readonly make: Effect.Effect<AgentEndpointResolver> = Effect.map(
    Ref.make<ResolverState>(emptyState),
    (state) => new AgentEndpointResolver(state),
  );

  private constructor(private readonly state: Ref.Ref<ResolverState>) {}

  /**
   * Atomically associate `(agentId, connectionId)` and the reverse
   * `(connectionId → agentId)` entry.
   *
   * Idempotent on the forward set: re-adding the same connection to the
   * same agent leaves the set unchanged ({@link HashSet.add} is set-union
   * semantics).
   *
   * Cross-agent ownership conflict (Phase 8 codex deferral on PR #458):
   * if `connectionId` is already in the reverse index for a *different*
   * agent, the new add takes ownership — the connection is removed from
   * the prior agent's forward set inside the same `Ref.update` so the
   * forward and reverse views stay invariant. Practically unreachable
   * but the detection is cheap and the alternative was a silent
   * forward-map leak.
   */
  add(agentId: AgentId, connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.state, (s) => {
      const prior = HashMap.get(s.byConnection, connId);
      let byAgent = s.byAgent;
      if (Option.isSome(prior) && prior.value !== agentId) {
        byAgent = HashMap.modifyAt(byAgent, prior.value, (existing) =>
          Option.flatMap(existing, (set) => {
            const next = HashSet.remove(set, connId);
            return HashSet.size(next) === 0 ? Option.none() : Option.some(next);
          }),
        );
      }
      return {
        byAgent: HashMap.modifyAt(byAgent, agentId, (existing) =>
          Option.some(
            Option.match(existing, {
              onNone: () => HashSet.make(connId),
              onSome: (set) => HashSet.add(set, connId),
            }),
          ),
        ),
        byConnection: HashMap.set(s.byConnection, connId, agentId),
      };
    });
  }

  /**
   * Atomically drop `(agentId, connectionId)` from the forward multimap
   * and, if the pair was actually present in the agent's set, drop
   * `connectionId` from the reverse index too.
   *
   * Idempotent. Calling `remove` for a `(agentId, connectionId)` pair
   * that was never added is a no-op — the disconnect path can fire it
   * unconditionally when the connection authed. For never-authed
   * connections, the disconnect path simply skips the call (no agentId
   * to address it with) and the resolver state is unchanged.
   *
   * Tearing the invariant matters when `connectionId` is genuinely owned
   * by a *different* agent than the caller asserts. The reverse index
   * is only cleared when `byAgent[agentId]` actually held `connectionId`;
   * a stray `remove(WRONG_AGENT, conn)` therefore cannot evict
   * `byConnection[conn]` from under the rightful owner. This guarantees
   * the two maps stay consistent under any sequence of mis-targeted
   * removes (programmer error or a re-issued lifecycle hook).
   *
   * If removing `connectionId` empties the agent's set, the agent key
   * itself is dropped from the forward map so {@link resolveAll} returns
   * the empty set rather than hitting an empty bucket.
   */
  remove(agentId: AgentId, connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.state, (s) => {
      const existed = Option.match(HashMap.get(s.byAgent, agentId), {
        onNone: () => false,
        onSome: (set) => HashSet.has(set, connId),
      });
      if (!existed) return s;
      return {
        byAgent: HashMap.modifyAt(s.byAgent, agentId, (existing) =>
          Option.flatMap(existing, (set) => {
            const next = HashSet.remove(set, connId);
            return HashSet.size(next) === 0 ? Option.none() : Option.some(next);
          }),
        ),
        byConnection: HashMap.remove(s.byConnection, connId),
      };
    });
  }

  /**
   * Hot-path fan-out lookup. Returns every connection id currently
   * associated with `agentId`. Read-only snapshot — the `HashSet` is
   * immutable and the caller cannot mutate the resolver through it.
   *
   * Phase 9b consumer-migration (sub-issue #460 amendment): post-rename
   * the return type is `HashSet<ConnectionId>` rather than the
   * `HashSet<EndpointAddress>` shape the pre-Phase-9b namespace split
   * carried. Consumers that previously read `EndpointAddress` values
   * out of the resolver and re-wrapped them around `connectionId` now
   * read `ConnectionId` directly.
   */
  resolveAll(agentId: AgentId): Effect.Effect<HashSet.HashSet<ConnectionId>> {
    return Effect.map(Ref.get(this.state), (s) =>
      Option.getOrElse(HashMap.get(s.byAgent, agentId), () =>
        HashSet.empty<ConnectionId>(),
      ),
    );
  }
}
