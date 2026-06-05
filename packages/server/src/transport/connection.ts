import { Data, Effect, HashMap, Match, Option, Ref } from "effect";
import type { SocketError } from "@effect/platform/Socket";
import type {
  ReverseCallbackError,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
  ReverseClient,
  ReverseCallError,
} from "@moltzap/protocol";
import {
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { AgentContext, AppContext } from "../transport/context.js";

/**
 * Send an awaitable RPC from server → client over the connection's reverse
 * client. Narrows `D` to the moderator-callback union so a client→server method
 * cannot be fired on the reverse channel by mistake. The caller
 * (`AppHost.callAppRpc`) sources the {@link Originator} from the registered
 * app's `AppEndpoint`, minted from the live `AppConnection` arm. Caller controls
 * timeout via `Effect.timeout` at the call site.
 */
export function sendRpcToClient(
  originator: Originator,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof DispatchAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof DispatchAuthorize>,
  ReverseCallbackError<typeof DispatchAuthorize> | ReverseCallError,
  never
>;
export function sendRpcToClient(
  originator: Originator,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof MessagesAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof MessagesAuthorize>,
  ReverseCallbackError<typeof MessagesAuthorize> | ReverseCallError,
  never
>;
export function sendRpcToClient(
  originator: Originator,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof TaskCreate }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof TaskCreate>,
  ReverseCallbackError<typeof TaskCreate> | ReverseCallError,
  never
>;
export function sendRpcToClient(
  originator: Originator,
  request: ReverseCallbackRequest,
): ReturnType<Originator["callback"]>;
export function sendRpcToClient(
  originator: Originator,
  request: ReverseCallbackRequest,
): ReturnType<Originator["callback"]> {
  return originator.callback(request);
}

// ===========================================================================
// Three-arm discriminated-union connection state. This IS the connections
// map's only entry shape. Handlers consume `AgentConnection` / `AppConnection`
// via `ConnectionTag`; the sanctioned construction + transition surface
// (`addUnauthenticated` / `authenticate` / `rollbackToUnauthenticated` /
// `removeAndReturn`) is the only mutator of `connectionsRef`.
// ===========================================================================

/**
 * The per-connection reverse `RpcClient&lt;ReverseRpcGroup>` the server fires
 * callbacks/notifications through. Constructed by protocol `MoltZapServer`
 * during socket accept and passed to
 * `ConnectionManager.addUnauthenticated` as a primitive-equivalent parameter.
 */
export type Originator = ReverseClient;

/**
 * The per-connection socket handle (write + shutdown). Lifted to a standalone
 * public type so `ConnectionManager.addUnauthenticated` can take it as a
 * constructible parameter without accepting a `Connection`-arm value.
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

// Module-private classes — constructors NOT exported (only the `export type`
// forms land). External modules that need an arm value go through
// `ConnectionManager.add` / `.authenticate` / `.rollbackToUnauthenticated`,
// which use these constructors internally.
//
// The `private readonly __brand: never` field is a NOMINAL seal: TypeScript is
// structurally typed by default, so without it an external module could forge
// an object literal matching the field shape and pass it through an
// `import type { AgentConnection }` parameter slot. The private member is
// unreachable from outside the class declaration (TS2741 / TS18013 at the use
// site), so external code cannot synthesize a value of any arm.
// eslint-disable-next-line agent-code-guard/manual-brand -- `__brand: never` is a NOMINAL CLASS seal, not a branded primitive; the refined-brand suggestion does not apply to a Data.TaggedClass instance type.
class UnauthenticatedConnection extends Data.TaggedClass(
  "UnauthenticatedConnection",
)<ConnectionBase> {
  private readonly __brand!: never;
}

// eslint-disable-next-line agent-code-guard/manual-brand -- `__brand: never` is a NOMINAL CLASS seal, not a branded primitive; the refined-brand suggestion does not apply to a Data.TaggedClass instance type.
class AgentConnection extends Data.TaggedClass("AgentConnection")<
  ConnectionBase & {
    readonly auth: AgentContext;

    /**
     * Server-side message-delivery-routing state: the set of conversation
     * ids this connection is subscribed to (the fan-out membership gate in
     * `network-send.ts → connectionCanReceive`). Hydrated on connect via the
     * Connect handler's `hydrateConnectionState`; maintained on subscribe
     * (`ConnectionManager.subscribeAgentsToConversation`) and on
     * `ConversationService.removeParticipant`. App-armed connections have no
     * conversation membership, so this field lives on the agent arm only.
     *
     * The per-connection cache is a known denormalization smell — a
     * first-class subscription index would replace it.
     */
    readonly conversationIds: Set<ConversationId>;
  }
> {
  private readonly __brand!: never;
}

// eslint-disable-next-line agent-code-guard/manual-brand -- `__brand: never` is a NOMINAL CLASS seal, not a branded primitive; the refined-brand suggestion does not apply to a Data.TaggedClass instance type.
class AppConnection extends Data.TaggedClass("AppConnection")<
  ConnectionBase & { readonly auth: AppContext }
> {
  private readonly __brand!: never;
}

export type { UnauthenticatedConnection, AgentConnection, AppConnection };

/** The three-arm connection state — the connections map's only entry shape. */
export type Connection =
  | UnauthenticatedConnection
  | AgentConnection
  | AppConnection;

/**
 * Outcome of `ConnectionManager.authenticate`'s atomic transition. The
 * success arms are SPLIT per minted arm so the Connect handler's
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
 * The ONE site of the `auth._tag` runtime check: mint the connection arm
 * matching the resolved principal. Module-private —
 * `ConnectionManager.authenticate` is the only caller. Splits the success
 * outcome per arm so the caller narrows `authed` without a cast.
 */
const mintAuthedArm = (
  base: ConnectionBase,
  auth: AgentContext | AppContext,
): { readonly outcome: TransitionOutcome; readonly minted: Connection } =>
  Match.value(auth).pipe(
    Match.tag("AgentContext", (agentAuth) => {
      // `conversationIds` starts empty; the Connect handler's
      // `hydrateConnectionState` populates it from the agent's
      // `conversation_participants` rows after this transition commits.
      const authed = new AgentConnection({
        ...base,
        auth: agentAuth,
        conversationIds: new Set<ConversationId>(),
      });
      return { outcome: { kind: "ok-agent", authed } as const, minted: authed };
    }),
    Match.tag("AppContext", (appAuth) => {
      const authed = new AppConnection({ ...base, auth: appAuth });
      return { outcome: { kind: "ok-app", authed } as const, minted: authed };
    }),
    Match.exhaustive,
  );

export class ConnectionManager {
  /**
   * The three-arm connections map. Module-private; the only mutators are
   * `addUnauthenticated` / `authenticate` / `rollbackToUnauthenticated` /
   * `removeAndReturn` below.
   */
  private readonly connectionsRef: Ref.Ref<
    HashMap.HashMap<ConnectionId, Connection>
  > = Effect.runSync(Ref.make(HashMap.empty<ConnectionId, Connection>()));

  // =========================================================================
  // Sanctioned construction + transition surface over the three-arm
  // `connectionsRef`. Every method below accepts only primitives or
  // publicly-constructible types (`AgentContext` / `AppContext` are exported
  // `Data.TaggedClass`); none accept an arm value, since the arm constructors
  // are module-private. Return types ARE the arms, since callers only READ.
  // =========================================================================

  /**
   * Insert a fresh `UnauthenticatedConnection`. Called by the socket handler
   * at WS-open. The ONLY construction site for the unauth arm. The
   * `Connect`-handler `authenticate` transition promotes it to the agent/app
   * arm in place.
   */
  addUnauthenticated(
    connId: ConnectionId,
    socket: WebSocketRef,
    originator: Originator,
  ): Effect.Effect<void> {
    return Ref.update(this.connectionsRef, (map) =>
      HashMap.set(
        map,
        connId,
        new UnauthenticatedConnection({ connId, socket, originator }),
      ),
    );
  }

  /** Non-mutating read. Callers discriminate on the returned arm's `_tag`. */
  peek(connId: ConnectionId): Effect.Effect<Option.Option<Connection>> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => HashMap.get(map, connId)),
    );
  }

  /**
   * Snapshot of every connection arm. Callers iterate + discriminate on `_tag`
   * (e.g. the shutdown loop reads `arm.socket.shutdown`).
   */
  allConnections(): Effect.Effect<readonly Connection[]> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => Array.from(HashMap.values(map))),
    );
  }

  /** Current connection count. */
  currentSize(): Effect.Effect<number> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => HashMap.size(map)),
    );
  }

  /**
   * Atomic per-connection authentication gate. Pattern-matches on
   * `auth._tag` ONCE to decide which arm to mint — the only surviving site of
   * that runtime check. Returns a split-per-arm `TransitionOutcome` so the
   * caller narrows without a cast.
   */
  authenticate(
    connId: ConnectionId,
    auth: AgentContext | AppContext,
  ): Effect.Effect<TransitionOutcome> {
    return Ref.modify(this.connectionsRef, (map) => {
      const current = HashMap.get(map, connId);
      if (Option.isNone(current)) {
        return [{ kind: "not-connected" } as const, map];
      }
      return Match.value(current.value).pipe(
        Match.tag(
          "AgentConnection",
          (existing): [TransitionOutcome, typeof map] => [
            { kind: "already-connected", existing },
            map,
          ],
        ),
        Match.tag(
          "AppConnection",
          (existing): [TransitionOutcome, typeof map] => [
            { kind: "already-connected", existing },
            map,
          ],
        ),
        Match.tag(
          "UnauthenticatedConnection",
          (unauth): [TransitionOutcome, typeof map] => {
            const { outcome, minted } = mintAuthedArm(
              {
                connId: unauth.connId,
                socket: unauth.socket,
                originator: unauth.originator,
              },
              auth,
            );
            return [outcome, HashMap.set(map, connId, minted)];
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
   */
  rollbackToUnauthenticated(connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.connectionsRef, (map) => {
      const current = HashMap.get(map, connId);
      if (Option.isNone(current)) return map;
      // Both authed arms roll back to the same unauth shape (only the shared
      // `ConnectionBase` fields carry over — auth + agent state are dropped);
      // the unauth arm is already at the target state.
      const demote = (authed: AgentConnection | AppConnection) =>
        HashMap.set(
          map,
          connId,
          new UnauthenticatedConnection({
            connId: authed.connId,
            socket: authed.socket,
            originator: authed.originator,
          }),
        );
      return Match.value(current.value).pipe(
        Match.tag("UnauthenticatedConnection", () => map),
        Match.tag("AgentConnection", demote),
        Match.tag("AppConnection", demote),
        Match.exhaustive,
      );
    });
  }

  /**
   * Atomic delete + return. Returns the removed
   * arm (or `undefined`) so the caller `Match.tag`s for auth-gated cleanup.
   */
  removeAndReturn(connId: ConnectionId): Effect.Effect<Connection | undefined> {
    return Ref.modify(this.connectionsRef, (map) => {
      const current = HashMap.get(map, connId);
      if (Option.isNone(current)) {
        return [undefined, map] as [Connection | undefined, typeof map];
      }
      return [current.value, HashMap.remove(map, connId)] as [
        Connection | undefined,
        typeof map,
      ];
    });
  }

  /**
   * Read-only lookup narrowed to the agent arm. App lookups go through
   * `AppRegistry` by `appId`; `UnauthenticatedConnection` and `AppConnection`
   * entries are skipped structurally (no `auth.agentId` to compare).
   */
  getByAgentConnection(
    agentId: AgentId,
  ): Effect.Effect<AgentConnection | null> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => {
        for (const conn of HashMap.values(map)) {
          if (
            conn._tag === "AgentConnection" &&
            conn.auth.agentId === agentId
          ) {
            return conn;
          }
        }
        return null;
      }),
    );
  }

  /**
   * Every live agent-arm connection of `agentId`. Multi-tab agents have one arm
   * per socket; the per-connection `conversationIds` subscription gate is
   * maintained on each. The agent-only consumers (fan-out, conversation
   * subscription maintenance) read this.
   */
  agentConnections(
    agentId: AgentId,
  ): Effect.Effect<readonly AgentConnection[]> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => {
        const out: AgentConnection[] = [];
        for (const conn of HashMap.values(map)) {
          if (
            conn._tag === "AgentConnection" &&
            conn.auth.agentId === agentId
          ) {
            out.push(conn);
          }
        }
        return out;
      }),
    );
  }

  /**
   * Add `conversationId` to the subscription set of every currently-connected
   * agent arm in `agentIds`. Idempotent (Set semantics); returns the
   * subscribed connection ids for observability. The arm's `conversationIds`
   * Set is mutated in place (the `Data.TaggedClass` field is a `readonly`
   * reference to a mutable Set — the reference never changes).
   */
  addConversationToAgents(
    agentIds: readonly AgentId[],
    conversationId: ConversationId,
  ): Effect.Effect<readonly ConnectionId[]> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => {
        const agentSet = new Set<AgentId>(agentIds);
        const subscribed: ConnectionId[] = [];
        for (const conn of HashMap.values(map)) {
          if (
            conn._tag === "AgentConnection" &&
            agentSet.has(conn.auth.agentId)
          ) {
            conn.conversationIds.add(conversationId);
            subscribed.push(conn.connId);
          }
        }
        return subscribed;
      }),
    );
  }

  /**
   * Seed the subscription set of a SINGLE agent-arm connection from its
   * persisted `conversation_participants` rows at connect time. No-op
   * if the entry is absent (close race) or not an agent arm. Mirrors the
   * legacy per-connection `hydrateConnectionState` loop.
   */
  hydrateConversationIds(
    connId: ConnectionId,
    conversationIds: readonly ConversationId[],
  ): Effect.Effect<void> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => {
        const current = HashMap.get(map, connId);
        if (Option.isNone(current)) return;
        const conn = current.value;
        if (conn._tag !== "AgentConnection") return;
        for (const id of conversationIds) conn.conversationIds.add(id);
      }),
    );
  }

  /**
   * Remove `conversationId` from the subscription set of every connected agent
   * arm of `agentId` (the inverse of {@link addConversationToAgents}). Used by
   * `ConversationService.removeParticipant`.
   */
  removeConversationFromAgent(
    agentId: AgentId,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => {
        for (const conn of HashMap.values(map)) {
          if (
            conn._tag === "AgentConnection" &&
            conn.auth.agentId === agentId
          ) {
            conn.conversationIds.delete(conversationId);
          }
        }
      }),
    );
  }
}
