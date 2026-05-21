/**
 * In-memory `AgentId → HashSet&lt;ConnectionId>` multimap with a paired
 * `ConnectionId → AgentId` reverse index.
 *
 * Why a multimap. An authenticated agent can hold multiple WebSocket
 * connections (web tab + CLI + mobile). Fan-out has to address every live
 * connection of that agent without re-scanning `ConnectionManager`. The
 * forward map (`HashMap&lt;AgentId, HashSet&lt;ConnectionId>>`) gives O(1)
 * fan-out via {@link AgentEndpointResolver.resolveAll}.
 *
 * Why a paired reverse index. Cross-agent ownership conflict detection:
 * if a connection id is already bound to a different agent, the resolver
 * evicts the prior owner from the forward map atomically inside the same
 * {@link Ref.update}. Practically unreachable (connection ids are UUIDs
 * minted at `crypto.randomUUID()` per WS accept), but the detection is
 * cheap and the alternative was a silent forward-map leak.
 *
 * Auth-lifecycle:
 * - Socket connect: NOT yet added to the resolver (no `agentId` known).
 * - `network/connect` success: {@link add} writes the entry atomically.
 * - Disconnect: {@link remove} removes the entry whether the connection
 *   was authed or not (idempotent on never-authed connections).
 *
 * Out of scope: cross-process / multi-server scaling. Resolver state is
 * process-local.
 */
import { Effect, HashMap, HashSet, Option, Ref } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";

/**
 * Brand a raw connection-id string. Used by call sites that mint a fresh
 * id (`socket-handler.ts` at WS accept) or in tests that name connections
 * with synthetic strings. `ConnectionId` itself lives at
 * `@moltzap/protocol/network`; the boundary cast here is the only
 * acceptable production construction since `crypto.randomUUID()` returns
 * `string` and `ConnectionId` is a `brandedString` (no UUID predicate).
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
   * the return type is `HashSet&lt;ConnectionId>` rather than the
   * `HashSet&lt;EndpointAddress>` shape the pre-Phase-9b namespace split
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
