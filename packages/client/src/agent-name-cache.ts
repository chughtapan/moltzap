/**
 * @file Agent id → display-name cache, backed by `agent/identity/agents/list`.
 *
 * Split out of `MoltZapService`: the six methods that owned this map touched
 * nothing else on the service except the RPC sender, so the cache carries its
 * own `Ref` and takes the sender as its only collaborator. Callers that render
 * a sender name (history formatting, cross-conversation context, the channel
 * adapters) go through {@link AgentNameCache.resolve}, which is cache-first and
 * never fails.
 */
import { HashMap, Effect, Option, Ref } from "effect";
import {
  AgentsList,
  type AgentCard,
  type AgentId,
} from "@moltzap/protocol/identity";
import type { ListCursor, ParamsOf, ResultOf } from "@moltzap/protocol/rpc";

/** One page of `agent/identity/agents/list`, as the sender returns it. */
type AgentsListResult = ResultOf<typeof AgentsList>;

/**
 * The only collaborator the cache needs: send one `agents/list` page. Generic
 * over the sender's error channel so the cache stays decoupled from any one
 * client's error union.
 */
export type ListAgentsFn<E> = (
  params: ParamsOf<typeof AgentsList>,
) => Effect.Effect<AgentsListResult, E>;

const PAGE_SIZE = 100;

/**
 * A cold agent is an expected transient state, so a lookup miss is not an
 * error — but an unbounded scan is. Paging stops here whether or not the
 * wanted ids were found.
 */
const MAX_PAGES = 20;

export class AgentNameCache<E> {
  private readonly namesRef: Ref.Ref<HashMap.HashMap<string, string>> =
    Effect.runSync(Ref.make(HashMap.empty<string, string>()));

  constructor(private readonly listAgents: ListAgentsFn<E>) {}

  /** Cached name for `agentId`, or `undefined` when never resolved. */
  get(agentId: string): string | undefined {
    return Option.getOrUndefined(
      HashMap.get(Effect.runSync(Ref.get(this.namesRef)), agentId),
    );
  }

  /** The whole map, for callers that format many senders at once. */
  snapshot(): HashMap.HashMap<string, string> {
    return Effect.runSync(Ref.get(this.namesRef));
  }

  /** Effectful read, for use inside `Effect.gen` bodies. */
  all(): Effect.Effect<HashMap.HashMap<string, string>> {
    return Ref.get(this.namesRef);
  }

  /** Drop every entry. Called when the service disconnects. */
  clear(): Effect.Effect<void> {
    return Ref.set(this.namesRef, HashMap.empty());
  }

  /** Record the names carried by an already-fetched page. */
  cache(agents: ReadonlyArray<AgentCard>): Effect.Effect<void> {
    if (agents.length === 0) return Effect.void;
    return Ref.update(this.namesRef, (names) => {
      let next = names;
      for (const agent of agents) {
        next = HashMap.set(next, agent.id, agent.name);
      }
      return next;
    });
  }

  /** Page until every id in `agentIds` is cached, or the pages run out. */
  cacheForIds(agentIds: ReadonlySet<string>): Effect.Effect<void, E> {
    return Effect.gen(this, function* () {
      const missing = new Set(agentIds);
      let cursor: ListCursor | undefined = undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: AgentsListResult = yield* this.listAgents(
          pageParams(cursor),
        );
        yield* this.cache(result.agents);
        for (const agent of result.agents) missing.delete(agent.id);
        if (missing.size === 0 || result.nextCursor === undefined) return;
        cursor = result.nextCursor;
      }
    });
  }

  /** First visible agent whose display name is exactly `agentName`. */
  findByName(agentName: string): Effect.Effect<AgentCard | undefined, E> {
    return Effect.gen(this, function* () {
      let cursor: ListCursor | undefined = undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: AgentsListResult = yield* this.listAgents(
          pageParams(cursor),
        );
        yield* this.cache(result.agents);
        const hit = result.agents.find((agent) => agent.name === agentName);
        if (hit !== undefined || result.nextCursor === undefined) return hit;
        cursor = result.nextCursor;
      }
      return undefined;
    });
  }

  /**
   * Cache-first name lookup. Never fails: falls back to `agentId` when the
   * RPC errors or the server has no record. The error path logs so ops can
   * see repeated lookup failures; the empty-response path is silent.
   */
  resolve(agentId: string, decoded: AgentId): Effect.Effect<string, never> {
    return Effect.gen(this, function* () {
      const cached = this.get(agentId);
      if (cached !== undefined) return cached;
      return yield* this.cacheForIds(new Set([decoded])).pipe(
        Effect.map(() => this.get(agentId) ?? agentId),
        Effect.catchAll((err) =>
          Effect.logWarning(
            "agent/identity/agents/list failed; falling back to agentId",
          ).pipe(
            Effect.annotateLogs({ agentId, err: String(err) }),
            Effect.as(agentId),
          ),
        ),
      );
    });
  }
}

function pageParams(
  cursor: ListCursor | undefined,
): ParamsOf<typeof AgentsList> {
  return cursor === undefined
    ? { limit: PAGE_SIZE }
    : { limit: PAGE_SIZE, cursor };
}
