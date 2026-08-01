// safer-arch-ignore folder-explicit-api-required: ConnectionManager and connection arms form the socket runtime boundary consumed by server composition.
import { Data, Effect, HashMap, HashSet, Match, Option, Ref } from "effect";
import type { SocketError } from "@effect/platform/Socket";
import type { ReverseClient, ConnectionId } from "@moltzap/protocol/socket";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentContext, AppContext } from "./context.js";

/**
 * The per-connection reverse `RpcClient&lt;ReverseRpcGroup>` the server fires
 * callbacks/notifications through. Constructed by protocol `MoltZapServer`
 * during socket accept and passed to
 * `ConnectionManager.addUnauthenticated` as a primitive-equivalent parameter.
 */
export type Originator = ReverseClient;

/**
 * The per-connection socket handle registered with `ConnectionManager`.
 */
export interface WebSocketRef {
  /**
   * Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed.
   */
  readonly write: (raw: string) => Effect.Effect<void, SocketError>;
  /** Close this connection's scope, tearing down the underlying socket. */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Shared base fields across all three connection arms. Module-private — not
 * exported. Every arm intersects this; the discriminator is the class tag.
 */
interface ConnectionBase {
  readonly connId: ConnectionId;
  readonly socket: WebSocketRef;
  readonly originator: Originator;
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

class AppConnection extends Data.TaggedClass("AppConnection")<
  ConnectionBase & { readonly auth: AppContext }
> {
  private readonly brandValue!: never;
}

/** Re-exports the public API from `current module`. */
export type { UnauthenticatedConnection, AgentConnection, AppConnection };

/** The three-arm connection state — the connections map's only entry shape. */
export type Connection =
  | UnauthenticatedConnection
  | AgentConnection
  | AppConnection;

/**
 * Outcome of `ConnectionManager.authenticate`'s atomic transition. The
 * success arms are split per minted arm so the Connect handler's
 * `Match.value(outcome).pipe(Match.when({ kind: "ok-agent" }, ...))` narrows
 * `authed` structurally — no `as AgentConnection` cast.
 */
export type TransitionOutcome =
  | { readonly kind: "not-connected" }
  | {
      readonly kind: "already-connected";
      readonly existing: AgentConnection | AppConnection;
    }
  | { readonly kind: "ok-agent"; readonly authed: AgentConnection }
  | { readonly kind: "ok-app"; readonly authed: AppConnection };

/**
 * Mint the connection arm matching the resolved principal. This is the single
 * runtime check of `auth._tag`; callers narrow through `TransitionOutcome`.
 * @param base Value supplied to the operation.
 * @param auth Value supplied to the operation.
 * @returns The mint authed arm result.
 */
const mintAuthedArm = (
  base: ConnectionBase,
  auth: AgentContext | AppContext,
): { readonly outcome: TransitionOutcome; readonly minted: Connection } =>
  Match.value(auth).pipe(
    Match.tag("AgentContext", (agentAuth) => {
      const authed = new AgentConnection({ ...base, auth: agentAuth });
      return { outcome: { kind: "ok-agent", authed } as const, minted: authed };
    }),
    Match.tag("AppContext", (appAuth) => {
      const authed = new AppConnection({ ...base, auth: appAuth });
      return { outcome: { kind: "ok-app", authed } as const, minted: authed };
    }),
    Match.exhaustive,
  );

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
   * at WebSocket open. The Connect handler promotes it to the agent/app arm.
   * @param connId Value supplied to the operation.
   * @param socket Value supplied to the operation.
   * @param originator Value supplied to the operation.
   * @returns The add unauthenticated result.
   */
  addUnauthenticated(
    connId: ConnectionId,
    socket: WebSocketRef,
    originator: Originator,
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => ({
      ...state,
      connections: HashMap.set(
        state.connections,
        connId,
        new UnauthenticatedConnection({ connId, socket, originator }),
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
   * Snapshot of every connection arm. Callers iterate + discriminate on `_tag`
   * (e.g. The shutdown loop reads `arm.socket.shutdown`).
   * @returns The current result.
   */
  allConnections(): Effect.Effect<readonly Connection[]> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => Array.from(HashMap.values(state.connections))),
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
   * Atomic per-connection authentication gate. Pattern-matches on
   * `auth._tag` once to decide which arm to mint. Returns a split-per-arm
   * `TransitionOutcome` so callers narrow without a cast.
   * @param connId Value supplied to the operation.
   * @param auth Value supplied to the operation.
   * @returns The current result.
   */
  authenticate(
    connId: ConnectionId,
    auth: AgentContext | AppContext,
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
          "AppConnection",
          (existing): [TransitionOutcome, typeof state] => [
            { kind: "already-connected", existing },
            state,
          ],
        ),
        Match.tag(
          "UnauthenticatedConnection",
          (unauth): [TransitionOutcome, typeof state] => {
            const { outcome, minted } = mintAuthedArm(
              {
                connId: unauth.connId,
                socket: unauth.socket,
                originator: unauth.originator,
              },
              auth,
            );
            return [
              outcome,
              {
                ...state,
                connections: HashMap.set(state.connections, connId, minted),
              },
            ];
          },
        ),
        Match.exhaustive,
      );
    });
  }

  /**
   * Roll an authenticated arm back to `UnauthenticatedConnection` on a
   * post-auth failure. Idempotent: no-op when the entry is absent or already
   * unauthenticated — safe against a racing close handler.
   * @param connId Value supplied to the operation.
   * @returns The current result.
   */
  rollbackToUnauthenticated(connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => {
      const current = HashMap.get(state.connections, connId);
      if (
        Option.isNone(current) ||
        current.value._tag === "UnauthenticatedConnection"
      ) {
        return state;
      }
      const authed = current.value;
      const connections = HashMap.set(
        state.connections,
        connId,
        new UnauthenticatedConnection({
          connId: authed.connId,
          socket: authed.socket,
          originator: authed.originator,
        }),
      );
      if (
        authed._tag === "AgentConnection" &&
        !hasAgentArm(connections, authed.auth.agentId)
      ) {
        return {
          connections,
          agentConversationSubscriptions: HashMap.remove(
            state.agentConversationSubscriptions,
            authed.auth.agentId,
          ),
        };
      }
      return { ...state, connections };
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
   * Read-only lookup narrowed to the agent arm. App lookups go through
   * `AppRegistry` by `appId`; `UnauthenticatedConnection` and `AppConnection`
   * entries are skipped structurally (no `auth.agentId` to compare).
   * @param agentId Identifier of the agent targeted by the operation.
   * @returns The found result.
   */
  getByAgentConnection(
    agentId: AgentId,
  ): Effect.Effect<AgentConnection | null> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => {
        let found: AgentConnection | null = null;
        eachAgentArm(state.connections, (conn) => {
          if (found === null && conn.auth.agentId === agentId) {
            found = conn;
          }
        });
        return found;
      }),
    );
  }

  /**
   * Every live agent-arm connection of `agentId`. Multi-tab agents have one arm
   * per socket. Agent-only consumers read this.
   * @param agentId Identifier of the agent targeted by the operation.
   * @returns The out result.
   */
  agentConnections(
    agentId: AgentId,
  ): Effect.Effect<readonly AgentConnection[]> {
    return Ref.get(this.stateRef).pipe(
      Effect.map((state) => {
        const out: AgentConnection[] = [];
        eachAgentArm(state.connections, (conn) => {
          if (conn.auth.agentId === agentId) {
            out.push(conn);
          }
        });
        return out;
      }),
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

  /**
   * Remove `conversationId` from the subscription index for `agentId` (the
   * inverse of {@link addConversationToAgents}). Used by
   * `ConversationService.removeParticipant`.
   * @param agentId Identifier of the agent targeted by the operation.
   * @param conversationId Value supplied to the operation.
   * @returns The existing result.
   */
  removeConversationFromAgent(
    agentId: AgentId,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    return Ref.update(this.stateRef, (state) => {
      const existing = HashMap.get(
        state.agentConversationSubscriptions,
        agentId,
      );
      if (Option.isNone(existing)) {
        return state;
      }
      const next = HashSet.remove(existing.value, conversationId);
      return {
        ...state,
        agentConversationSubscriptions:
          HashSet.size(next) === 0
            ? HashMap.remove(state.agentConversationSubscriptions, agentId)
            : HashMap.set(state.agentConversationSubscriptions, agentId, next),
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
