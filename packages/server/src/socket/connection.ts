// safer-arch-ignore folder-explicit-api-required: ConnectionManager and connection arms form the socket runtime boundary consumed by server composition.
import {
  Context,
  Data,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Ref,
} from "effect";
import type { ReverseClient, ConnectionId } from "@moltzap/protocol/socket";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";

/**
 * Closed agent lifecycle states. Mirrors
 * `core-schema.sql → CREATE TYPE agent_status AS ENUM (...)`. The closed
 * union makes the active-agent check exhaustive — adding a state forces every
 * consumer switch to handle it.
 */
export type AgentStatus = "active" | "suspended";

/**
 * The principal context stored on an authenticated socket connection. Every
 * gated method's `requires` head selects this arm.
 */
export class AgentContext extends Data.TaggedClass("AgentContext")<{
  readonly agentId: AgentId;
  readonly agentStatus: AgentStatus;
  readonly ownerUserId: UserId;
}> {}

/**
 * Mint an {@link AgentContext} from authenticator fields. The `agent_status`
 * SQL enum constrains stored values to {@link AgentStatus}, but the DB driver
 * types it as `string`, so any other value is an impossible-state defect.
 * @param parts Value supplied to the operation.
 * @param parts.agentId Value supplied to the operation.
 * @param parts.agentStatus Value supplied to the operation.
 * @param parts.ownerUserId Value supplied to the operation.
 * @returns The agent context from result.
 */
export function agentContextFrom(parts: {
  readonly agentId: AgentId;
  readonly agentStatus: string;
  readonly ownerUserId: UserId;
}): Effect.Effect<AgentContext> {
  switch (parts.agentStatus) {
    case "active":
    case "suspended":
      return Effect.succeed(
        new AgentContext({
          agentId: parts.agentId,
          agentStatus: parts.agentStatus,
          ownerUserId: parts.ownerUserId,
        }),
      );
    default:
      return Effect.die(
        new Error(
          `agentContextFrom: agent_status outside closed union: ${parts.agentStatus}`,
        ),
      );
  }
}

/**
 * Shared base fields across both connection arms. Module-private — not
 * exported. Every arm intersects this; the discriminator is the class tag.
 */
interface ConnectionBase {
  readonly connId: ConnectionId;
  /** Reverse RPC client created during socket accept for server→agent notifications. */
  readonly originator: ReverseClient;
}

// Module-private classes with private members keep external modules from
// forging connection arms structurally. Callers receive arm values only through
// `ConnectionManager`.

class UnauthenticatedConnection extends Data.TaggedClass(
  "UnauthenticatedConnection",
)<ConnectionBase> {
  private readonly brand!: never;
}

class AgentConnection extends Data.TaggedClass("AgentConnection")<
  ConnectionBase & { readonly auth: AgentContext }
> {
  private readonly brandValue!: never;
}

/** Re-exports the public API from `current module`. */
export type { UnauthenticatedConnection, AgentConnection };

/** The two-arm connection state — the connections map's only entry shape. */
export type Connection = UnauthenticatedConnection | AgentConnection;

/**
 * Outcome of `ConnectionManager.authenticate`'s atomic transition. The success
 * arm carries the minted connection so the Connect handler's
 * `Match.value(outcome).pipe(Match.when({ kind: "ok-agent" }, ...))` narrows
 * `authed` structurally — no `as AgentConnection` cast.
 */
export type TransitionOutcome =
  | { readonly kind: "not-connected" }
  | {
      readonly kind: "already-connected";
      readonly existing: AgentConnection;
    }
  | { readonly kind: "ok-agent"; readonly authed: AgentConnection };

/**
 * Visit every agent-arm connection in `map`. Centralizes the
 * `_tag === "AgentConnection"` structural narrowing that every agent-scoped
 * reader/mutator shares.
 * @param map Value supplied to the operation.
 * @param visit Value supplied to the operation.
 */
const eachAgentArm = (
  map: HashMap.HashMap<ConnectionId, Connection>,
  visit: (conn: AgentConnection) => void,
): void => {
  for (const conn of HashMap.values(map)) {
    if (conn._tag === "AgentConnection") {
      visit(conn);
    }
  }
};

/**
 * Whether `map` still contains a live agent arm for `agentId`.
 * @param map Value supplied to the operation.
 * @param agentId Identifier of the agent targeted by the operation.
 * @returns Whether agent arm.
 */
const hasAgentArm = (
  map: HashMap.HashMap<ConnectionId, Connection>,
  agentId: AgentId,
): boolean => {
  let found = false;
  eachAgentArm(map, (conn) => {
    if (conn.auth.agentId === agentId) {
      found = true;
    }
  });
  return found;
};

interface ConnectionManagerState {
  readonly connections: HashMap.HashMap<ConnectionId, Connection>;
  readonly agentConversationSubscriptions: HashMap.HashMap<
    AgentId,
    HashSet.HashSet<ConversationId>
  >;
}

const addConversationIds = (
  subscriptions: ConnectionManagerState["agentConversationSubscriptions"],
  agentId: AgentId,
  conversationIds: readonly ConversationId[],
): ConnectionManagerState["agentConversationSubscriptions"] => {
  const existing = Option.getOrElse(HashMap.get(subscriptions, agentId), () =>
    HashSet.empty<ConversationId>(),
  );
  let next = existing;
  for (const conversationId of conversationIds) {
    next = HashSet.add(next, conversationId);
  }
  return HashMap.set(subscriptions, agentId, next);
};

/** Implements connection manager. */
export class ConnectionManager {
  /**
   * Connections and their per-agent delivery projection share one Ref so
   * authentication, disconnect cleanup, and subscription updates are atomic.
   * This prevents an old last-disconnect cleanup from deleting a newly
   * authenticated socket's freshly hydrated subscriptions.
   */
  private readonly stateRef: Ref.Ref<ConnectionManagerState> = Effect.runSync(
    Ref.make({
      connections: HashMap.empty<ConnectionId, Connection>(),
      agentConversationSubscriptions: HashMap.empty<
        AgentId,
        HashSet.HashSet<ConversationId>
      >(),
    }),
  );

  /**
   * Insert a fresh `UnauthenticatedConnection`. Called by the socket handler
   * at WebSocket open. The Connect handler promotes it to the agent arm.
   * @param connId Value supplied to the operation.
   * @param originator Value supplied to the operation.
   * @returns The add unauthenticated result.
   */
  addUnauthenticated(
    connId: ConnectionId,
    originator: ReverseClient,
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => ({
      ...state,
      connections: HashMap.set(
        state.connections,
        connId,
        new UnauthenticatedConnection({ connId, originator }),
      ),
    }));
  }

  /**
   * Non-mutating read. Callers discriminate on the returned arm's `_tag`.
   * @param connId Value supplied to the operation.
   * @returns The current result.
   */
  peek(connId: ConnectionId): Effect.Effect<Option.Option<Connection>> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => HashMap.get(state.connections, connId)),
    );
  }

  /**
   * Current connection count.
   * @returns The current result.
   */
  currentSize(): Effect.Effect<number> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => HashMap.size(state.connections)),
    );
  }

  /**
   * Atomic per-connection authentication gate. Mints the agent arm from the
   * unauthenticated entry and returns a `TransitionOutcome` whose success arm
   * carries the minted connection, so callers narrow without a cast.
   * @param connId Value supplied to the operation.
   * @param auth Value supplied to the operation.
   * @returns The current result.
   */
  authenticate(
    connId: ConnectionId,
    auth: AgentContext,
  ): Effect.Effect<TransitionOutcome> {
    return Ref.modify(this.stateRef, (state) => {
      const current = HashMap.get(state.connections, connId);
      if (Option.isNone(current)) {
        return [{ kind: "not-connected" } as const, state];
      }
      return Match.value(current.value).pipe(
        Match.tag(
          "AgentConnection",
          (existing): [TransitionOutcome, typeof state] => [
            { kind: "already-connected", existing },
            state,
          ],
        ),
        Match.tag(
          "UnauthenticatedConnection",
          (unauth): [TransitionOutcome, typeof state] => {
            const authed = new AgentConnection({
              connId: unauth.connId,
              originator: unauth.originator,
              auth,
            });
            return [
              { kind: "ok-agent", authed },
              {
                ...state,
                connections: HashMap.set(state.connections, connId, authed),
              },
            ];
          },
        ),
        Match.exhaustive,
      );
    });
  }

  /**
   * Atomic delete + return. Returns the removed
   * arm (or `undefined`) so the caller `Match.tag`s for auth-gated cleanup.
   * @param connId Value supplied to the operation.
   * @returns The current result.
   */
  removeAndReturn(connId: ConnectionId): Effect.Effect<Connection | undefined> {
    return Ref.modify(
      this.stateRef,
      (state): [Connection | undefined, ConnectionManagerState] => {
        const current = HashMap.get(state.connections, connId);
        if (Option.isNone(current)) {
          return [undefined, state];
        }
        const removed = current.value;
        const connections = HashMap.remove(state.connections, connId);
        const agentConversationSubscriptions =
          removed._tag === "AgentConnection" &&
          !hasAgentArm(connections, removed.auth.agentId)
            ? HashMap.remove(
                state.agentConversationSubscriptions,
                removed.auth.agentId,
              )
            : state.agentConversationSubscriptions;
        return [removed, { connections, agentConversationSubscriptions }];
      },
    );
  }

  /**
   * Add `conversationId` to the first-class per-agent subscription index for
   * each listed agent that currently has a live agent arm. Offline agents are
   * hydrated from the database when they connect, so retaining them here would
   * only create stale, unbounded cache entries.
   * @param agentIds Value supplied to the operation.
   * @param conversationId Value supplied to the operation.
   * @returns The requested agent ids result.
   */
  addConversationToAgents(
    agentIds: readonly AgentId[],
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => {
      const requestedAgentIds = new Set(agentIds);
      const connectedAgentIds = new Set<AgentId>();
      eachAgentArm(state.connections, (conn) => {
        if (requestedAgentIds.has(conn.auth.agentId)) {
          connectedAgentIds.add(conn.auth.agentId);
        }
      });
      let agentConversationSubscriptions = state.agentConversationSubscriptions;
      for (const agentId of connectedAgentIds) {
        agentConversationSubscriptions = addConversationIds(
          agentConversationSubscriptions,
          agentId,
          [conversationId],
        );
      }
      return { ...state, agentConversationSubscriptions };
    });
  }

  /**
   * Merge an agent's persisted `conversation_participants` rows into the
   * first-class subscription index at connect time. The entry is cleared when
   * the last agent arm disconnects, so reconnect hydration starts from an
   * empty set. Additive hydration preserves a conversation created after the
   * DB snapshot was loaded but before this method runs.
   * @param connId Value supplied to the operation.
   * @param conversationIds Value supplied to the operation.
   * @returns The current result.
   */
  hydrateConversationIds(
    connId: ConnectionId,
    conversationIds: readonly ConversationId[],
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => {
      const current = HashMap.get(state.connections, connId);
      if (Option.isNone(current) || current.value._tag !== "AgentConnection") {
        return state;
      }
      return {
        ...state,
        agentConversationSubscriptions: addConversationIds(
          state.agentConversationSubscriptions,
          current.value.auth.agentId,
          conversationIds,
        ),
      };
    });
  }

  isAgentSubscribedToConversation(
    agentId: AgentId,
    conversationId: ConversationId,
  ): Effect.Effect<boolean> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) =>
        Option.match(
          HashMap.get(state.agentConversationSubscriptions, agentId),
          {
            onNone: () => false,
            onSome: (conversationIds) =>
              HashSet.has(conversationIds, conversationId),
          },
        ),
      ),
    );
  }
}

/** Implements connection tag. */
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}

/** Implements connection manager tag. */
export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}

/** Provides the connection manager live runtime value. */
export const connectionManagerLive = Layer.sync(
  ConnectionManagerTag,
  () => new ConnectionManager(),
);
