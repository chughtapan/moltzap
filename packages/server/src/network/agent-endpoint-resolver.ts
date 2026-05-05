/**
 * In-memory `AgentId → Set<EndpointAddress>` multimap with a paired
 * `EndpointAddress → ConnectionId` reverse index.
 *
 * Plan: `docs/plans/layered-network-refactor-2026-05.md` §2.10 (Slice G1
 * scope), §2.11 (resolver constraint). Issue #426 acceptance.
 *
 * Why a multimap. An authenticated agent can hold multiple WebSocket
 * connections (web tab + CLI + mobile). Fan-out has to address every live
 * connection of that agent without re-scanning `ConnectionManager`. The
 * forward map (`HashMap<AgentId, HashSet<EndpointAddress>>`) gives O(1)
 * fan-out via {@link AgentEndpointResolver.resolveAll}.
 *
 * Why a paired reverse index. {@link NetworkSendService.send} routes by an
 * already-resolved `EndpointAddress` (the network's stable wire identity
 * for a recipient), not by `AgentId`. Without the reverse index, the send
 * path would either O(N) scan the forward map or do a DB lookup — both
 * violate the §2.11 perf assertion ("O(1) hot path. No DB lookup."). The
 * reverse index is invariant: every entry in the forward map's union of
 * sets has exactly one matching reverse-index entry. Both updates happen
 * inside a single {@link Ref.update} so the invariant cannot tear.
 *
 * Why the connection id is the routing target. The address format
 * `tm:agent:<connId>` is stable for the lifetime of the WS connection
 * and unique across connections (connId is a UUID minted at socket
 * accept). The reverse index stores `connId` directly so a send-time
 * lookup goes resolver → connId → `ConnectionManager.get(connId)` with
 * no parsing of the address string at the hot path.
 *
 * Auth-lifecycle (per §2.11):
 * - Socket connect: NOT yet added to the resolver (no `agentId` known).
 * - `auth/connect` success: {@link add} writes the entry atomically.
 * - Disconnect: {@link remove} removes the entry whether the connection
 *   was authed or not (idempotent on never-authed connections).
 *
 * Out of scope for G1:
 * - Cross-process / multi-server scaling. Resolver state is process-local.
 * - TM (`tm:app:`) endpoint registration. {@link NetworkSendService.send}
 *   handles `tm:app:` separately (Phase 9 territory).
 */
import { Effect, HashMap, HashSet, Option, Ref } from "effect";
import {
  makeEndpointAddress,
  type AgentId,
  type EndpointAddress,
} from "@moltzap/protocol/network";

/**
 * Mint the `EndpointAddress` for an agent's WebSocket connection.
 *
 * Format: `tm:agent:<connId>`. The connection id is a UUID (see
 * `app/server.ts:418` — `crypto.randomUUID()`), so the result satisfies
 * the `tm:<kind>:<uuid>` brand predicate at
 * `packages/protocol/src/network/actor-model.ts:61`.
 *
 * Distinct namespace from `endpointAddressForAgent` in
 * `services/task.service.ts`, which mints `tm:agent:<agentId>` for durable
 * task-manager registration. Both share the `tm:agent:` prefix because the
 * brand only checks `kind ∈ {agent, app}` and that the trailing token is a
 * UUID — the brand is intentionally agnostic about which UUID it carries.
 * The two namespaces never collide in a single map: the resolver is keyed
 * by per-connection addresses; the durable TM column lives on
 * `tasks.tm_endpoint_address`. {@link NetworkSendService.send} also routes
 * the two kinds through different code paths.
 */
export const agentConnectionEndpointAddress = (
  connectionId: string,
): EndpointAddress => makeEndpointAddress("agent", connectionId);

/**
 * Snapshot of the resolver's combined state. Held in a single {@link Ref}
 * so atomic updates touch both halves at once. Forward and reverse must
 * stay invariant; see module doc.
 */
interface ResolverState {
  readonly byAgent: HashMap.HashMap<AgentId, HashSet.HashSet<EndpointAddress>>;
  readonly byAddress: HashMap.HashMap<EndpointAddress, string>;
}

const emptyState: ResolverState = {
  byAgent: HashMap.empty<AgentId, HashSet.HashSet<EndpointAddress>>(),
  byAddress: HashMap.empty<EndpointAddress, string>(),
};

/**
 * Multimap of agent → endpoint addresses, plus a reverse index from
 * address → connection id.
 *
 * All mutators run inside a single {@link Ref.update} so the forward and
 * reverse views never disagree, even under concurrent {@link add} /
 * {@link remove} calls from independent `auth/connect` and disconnect
 * fibers.
 */
export class AgentEndpointResolver {
  static make: Effect.Effect<AgentEndpointResolver> = Effect.map(
    Ref.make<ResolverState>(emptyState),
    (state) => new AgentEndpointResolver(state),
  );

  private constructor(private readonly state: Ref.Ref<ResolverState>) {}

  /**
   * Atomically associate `(agentId, address)` and `(address, connectionId)`.
   *
   * Idempotent on the forward set: re-adding the same address to the same
   * agent leaves the set unchanged ({@link HashSet.add} is set-union
   * semantics). The reverse index overwrites — a subsequent `add` for the
   * same address with a different connection id wins. In practice the
   * caller mints `address` from `connectionId` via
   * {@link agentConnectionEndpointAddress}, so the address is unique per
   * connection and the reverse-overwrite path only fires on programmer
   * error.
   */
  add(
    agentId: AgentId,
    address: EndpointAddress,
    connectionId: string,
  ): Effect.Effect<void> {
    return Ref.update(this.state, (s) => ({
      byAgent: HashMap.modifyAt(s.byAgent, agentId, (existing) =>
        Option.some(
          Option.match(existing, {
            onNone: () => HashSet.make(address),
            onSome: (set) => HashSet.add(set, address),
          }),
        ),
      ),
      byAddress: HashMap.set(s.byAddress, address, connectionId),
    }));
  }

  /**
   * Atomically drop `(agentId, address)` from the forward multimap and,
   * if the pair was actually present in the agent's set, drop `address`
   * from the reverse index too.
   *
   * Idempotent. Calling `remove` for a `(agentId, address)` pair that was
   * never added is a no-op — the disconnect path can fire it
   * unconditionally when the connection authed. For never-authed
   * connections, the disconnect path simply skips the call (no agentId
   * to address it with) and the resolver state is unchanged.
   *
   * Tearing the invariant matters when `address` is genuinely owned by
   * a *different* agent than the caller asserts. The reverse index is
   * only cleared when `byAgent[agentId]` actually held `address`; a
   * stray `remove(WRONG_AGENT, address)` therefore cannot evict
   * `byAddress[address]` from under the rightful owner. This guarantees
   * the two maps stay consistent under any sequence of mis-targeted
   * removes (programmer error or a re-issued lifecycle hook).
   *
   * If removing `address` empties the agent's set, the agent key itself
   * is dropped from the forward map so {@link resolveAll} returns the
   * empty set rather than hitting an empty bucket.
   */
  remove(agentId: AgentId, address: EndpointAddress): Effect.Effect<void> {
    return Ref.update(this.state, (s) => {
      const existed = Option.match(HashMap.get(s.byAgent, agentId), {
        onNone: () => false,
        onSome: (set) => HashSet.has(set, address),
      });
      if (!existed) return s;
      return {
        byAgent: HashMap.modifyAt(s.byAgent, agentId, (existing) =>
          Option.flatMap(existing, (set) => {
            const next = HashSet.remove(set, address);
            return HashSet.size(next) === 0 ? Option.none() : Option.some(next);
          }),
        ),
        byAddress: HashMap.remove(s.byAddress, address),
      };
    });
  }

  /**
   * Hot-path fan-out lookup. Returns every endpoint address currently
   * associated with `agentId`. Read-only snapshot — the `HashSet` is
   * immutable and the caller cannot mutate the resolver through it.
   */
  resolveAll(
    agentId: AgentId,
  ): Effect.Effect<HashSet.HashSet<EndpointAddress>> {
    return Effect.map(Ref.get(this.state), (s) =>
      Option.getOrElse(HashMap.get(s.byAgent, agentId), () =>
        HashSet.empty<EndpointAddress>(),
      ),
    );
  }

  /**
   * Hot-path send-routing lookup. Returns the connection id bound to
   * `address`, or `Option.none()` if no live connection holds that
   * address. {@link NetworkSendService.send} composes this with
   * `ConnectionManager.get` to produce the writable connection.
   */
  connectionForAddress(
    address: EndpointAddress,
  ): Effect.Effect<Option.Option<string>> {
    return Effect.map(Ref.get(this.state), (s) =>
      HashMap.get(s.byAddress, address),
    );
  }
}
