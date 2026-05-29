import { Data, Effect, HashMap, Match, Option, Ref, type Scope } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  makeServerConnection,
  type AnyTaskCallbackRpcDefinition,
  type ParamsOf,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
  type ServerConnection,
  type ServerHandlers,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import {
  AgentContext,
  AppContext,
  type AuthenticatedContext,
  type DispatchContext,
} from "../transport/context.js";

export interface MoltZapConnection {
  id: ConnectionId;

  /**
   * Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed.
   */
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>;

  /** Close this connection's scope, tearing down the underlying socket. */
  shutdown: Effect.Effect<void>;
  auth: AuthenticatedContext | null;
  lastPong: number;
  conversationIds: Set<string>;
  mutedConversations: Set<string>;

  /**
   * Per-socket Spec F (#617) typed-dispatcher `ServerConnection`. Carries
   * BOTH the inbound dispatcher (`handle` over the static
   * `ServerHandlers&lt;DispatchContext>` table) AND the outbound originator
   * (`call` / `notify` / `resolve` / `failAllPending`) for the
   * server→client appCallback channel. Mints `srv-${connId}-N` request
   * ids, tracks pending Deferreds, and fails every still-pending call
   * with `NotConnectedError` when the surrounding scope closes. The
   * per-conversation `sendRpcToClient` wrapper narrows the outbound call
   * to `AnyTaskCallbackRpcDefinition`.
   */
  readonly originator: ServerConnection<DispatchContext>;
}

/**
 * Allocate a per-connection Spec F (#617) typed `ServerConnection` whose
 * request ids are prefixed `srv-${connectionId}` (keeps server-originated
 * ids disjoint from client ids in logs and captures). The Scope finalizer
 * registered by the internalized originator helper drains pending
 * Deferreds with `NotConnectedError` when the connection scope closes.
 *
 * Test-only: `handlers` defaults to the empty record (no inbound
 * dispatch). Production code passes the application's
 * `ServerHandlers&lt;DispatchContext>` table via `socket-handler.ts → openSocketSession`.
 */
export function acquireConnectionRpcClient(
  connectionId: ConnectionId,
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>,
  handlers: ServerHandlers<DispatchContext> = {} as ServerHandlers<DispatchContext>,
  // Providers default to empty: the test-only `originator` overload
  // never drives a real handler whose body yields capabilities, so the
  // dispatcher's per-tag lookup is unexercised. Production wiring at
  // `socket-handler.ts → openSocketSession` passes the real provider
  // table (`serverCapabilityProviders`). Decoupling avoids a runtime
  // import cycle through `app/capability-providers.ts → app/layers.ts →
  // transport/connection.ts`.
  capabilities: Record<
    string,
    (args: unknown) => Effect.Effect<unknown, unknown, unknown>
  > = {},
): Effect.Effect<ServerConnection<DispatchContext>, never, Scope.Scope> {
  return makeServerConnection({
    id: connectionId,
    handlers,
    capabilities,
    write,
    idPrefix: `srv-${connectionId}`,
  });
}

/**
 * Send an awaitable RPC from server → client over `originator`'s WebSocket.
 *
 * Generic-narrowing wrapper around `originator.call` that constrains `D` to
 * the task-callback RPC union — prevents accidental dispatch of a
 * client→server method on the appCallback channel. Takes the bare
 * {@link Originator} surface (the only field a server→client RPC needs); the
 * caller (`AppHost.callAppRpc`) sources it from the registered app's
 * `AppEndpoint`, which is minted from the live `AppConnection` arm's
 * `originator`.
 *
 * Caller controls timeout via `Effect.timeout` at the call site.
 */
export function sendRpcToClient<D extends AnyTaskCallbackRpcDefinition>(
  originator: Originator,
  definition: D,
  params: ParamsOf<D>,
): Effect.Effect<ResultOf<D>, RpcCallError, never> {
  // `AnyTaskCallbackRpcDefinition` is a strict subset of the originator's
  // `AnyServerRpcDefinition` bound; the cast widens to the originator's
  // generic constraint shape without losing the per-definition
  // narrowing the caller provides.
  const call = originator.call as <D2 extends RpcDefinition<string, any, any>>(
    definition: D2,
    params: ParamsOf<D2>,
  ) => Effect.Effect<ResultOf<D2>, RpcCallError>;
  return call(definition, params);
}

// ===========================================================================
// D #705 §1.1 / §3 — three-arm discriminated-union connection state.
//
// Added ALONGSIDE the legacy `MoltZapConnection` surface above. The full
// cutover (handlers consuming `AgentConnection` / `AppConnection` directly,
// the connections map switching to this union as its only entry shape) lands
// in a later phase; this phase introduces the types + sanctioned construction
// methods so downstream phases compile against a published contract.
// ===========================================================================

/**
 * The outbound originator + inbound dispatcher carried by every connection.
 * Publicly constructible (via `acquireConnectionRpcClient` above); passed to
 * `ConnectionManager.add` as a primitive-equivalent parameter.
 */
export type Originator = ServerConnection<DispatchContext>;

/**
 * The per-connection socket handle. The write/shutdown surface the transport
 * already exposes on `MoltZapConnection`; lifted to a standalone public type
 * so `ConnectionManager.add` can take it as a constructible parameter without
 * accepting a `Connection`-arm value.
 */
export interface WebSocketRef {
  /**
   * Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed.
   */
  readonly write: (raw: string) => Effect.Effect<void, Socket.SocketError>;
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
// eslint-disable-next-line agent-code-guard/manual-brand -- `__brand: never` is a NOMINAL CLASS seal (§3.3), not a branded primitive; the refined-brand suggestion does not apply to a Data.TaggedClass instance type.
class UnauthenticatedConnection extends Data.TaggedClass(
  "UnauthenticatedConnection",
)<ConnectionBase> {
  private readonly __brand: never = undefined as never;
}

// eslint-disable-next-line agent-code-guard/manual-brand -- `__brand: never` is a NOMINAL CLASS seal (§3.3), not a branded primitive; the refined-brand suggestion does not apply to a Data.TaggedClass instance type.
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
     * The per-connection cache is a known denormalization smell tracked as a
     * first-class-subscription-index redesign in chughtapan/moltzap#718 — out
     * of scope for #705; carried forward branded here.
     */
    readonly conversationIds: Set<ConversationId>;
  }
> {
  private readonly __brand: never = undefined as never;
}

// eslint-disable-next-line agent-code-guard/manual-brand -- `__brand: never` is a NOMINAL CLASS seal (§3.3), not a branded primitive; the refined-brand suggestion does not apply to a Data.TaggedClass instance type.
class AppConnection extends Data.TaggedClass("AppConnection")<
  ConnectionBase & { readonly auth: AppContext }
> {
  private readonly __brand: never = undefined as never;
}

export type { UnauthenticatedConnection, AgentConnection, AppConnection };

/** The three-arm connection state. Replaces `MoltZapConnection` at cutover. */
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
 * The ONE surviving site of the `auth._tag` runtime check (§1.1 v21): mint
 * the connection arm matching the resolved principal. Module-private —
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
  private connections = new Map<ConnectionId, MoltZapConnection>();

  /**
   * D #705 §1.1 — the three-arm connections map. Module-private; the only
   * mutators are `add` / `authenticate` / `rollbackToUnauthenticated` /
   * `removeAndReturn` below. Lives alongside the legacy `connections` map
   * during the additive phase; the cutover phase collapses the two.
   */
  private readonly connectionsRef: Ref.Ref<
    HashMap.HashMap<ConnectionId, Connection>
  > = Effect.runSync(Ref.make(HashMap.empty<ConnectionId, Connection>()));

  add(conn: MoltZapConnection): void {
    this.connections.set(conn.id, conn);
  }

  remove(id: ConnectionId): void {
    this.connections.delete(id);
  }

  get(id: ConnectionId): MoltZapConnection | undefined {
    return this.connections.get(id);
  }

  // =========================================================================
  // D #705 §5.2 — sanctioned construction + transition surface over the
  // three-arm `connectionsRef`. Every method below accepts only primitives or
  // publicly-constructible types (`AgentContext` / `AppContext` are exported
  // `Data.TaggedClass`); none accept an arm value, since the arm constructors
  // are module-private. Return types ARE the arms, since callers only READ.
  // =========================================================================

  /**
   * Insert a fresh `UnauthenticatedConnection`. Called by the socket handler
   * at WS-open. The ONLY construction site for the unauth arm.
   *
   * Named `addUnauthenticated` during the additive phase to coexist with the
   * legacy `add(conn: MoltZapConnection)`; the cutover phase deletes the
   * legacy method and renames this to `add` (the §5.2 contract name).
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
   * Snapshot of every connection arm (§5.2). Replaces the legacy `all()`;
   * callers iterate + discriminate on `_tag` (e.g. the shutdown loop reads
   * `arm.socket.shutdown`).
   */
  allConnections(): Effect.Effect<readonly Connection[]> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => Array.from(HashMap.values(map))),
    );
  }

  /** Current connection count (§5.2). Replaces the legacy `size` getter. */
  currentSize(): Effect.Effect<number> {
    return Ref.get(this.connectionsRef).pipe(
      Effect.map((map) => HashMap.size(map)),
    );
  }

  /**
   * Atomic per-connection authentication gate (§3 STEP C). Pattern-matches on
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
   * Roll an authenticated arm back to `UnauthenticatedConnection` (§3 STEP D
   * failure). Idempotent: no-op when the entry is absent or already
   * unauthenticated — safe against a racing close handler.
   */
  rollbackToUnauthenticated(connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.connectionsRef, (map) => {
      const current = HashMap.get(map, connId);
      if (Option.isNone(current)) return map;
      return Match.value(current.value).pipe(
        Match.tag("UnauthenticatedConnection", () => map),
        Match.tag("AgentConnection", (authed) =>
          HashMap.set(
            map,
            connId,
            new UnauthenticatedConnection({
              connId: authed.connId,
              socket: authed.socket,
              originator: authed.originator,
            }),
          ),
        ),
        Match.tag("AppConnection", (authed) =>
          HashMap.set(
            map,
            connId,
            new UnauthenticatedConnection({
              connId: authed.connId,
              socket: authed.socket,
              originator: authed.originator,
            }),
          ),
        ),
        Match.exhaustive,
      );
    });
  }

  /**
   * Atomic delete + return (§8.2 close handler STEP 0). Returns the removed
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
   * Read-only lookup narrowed to the agent arm (§5.2). App lookups go through
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
   * Every live agent-arm connection of `agentId` (§5.2). Multi-tab agents
   * have one arm per socket; the per-connection `conversationIds`
   * subscription gate is maintained on each. Replaces the legacy
   * `getByAgent` for the agent-only consumers (fan-out, conversation
   * subscription maintenance).
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
   * Rebind `ownerUserId` on every connected agent arm of `agentId` after a
   * successful claim (§5.2). The `AgentContext` arm field is immutable, so each
   * matching `AgentConnection` is rebuilt with a fresh `AgentContext` carrying
   * the new owner (its `conversationIds` Set + socket/originator are carried
   * forward by reference). Replaces the legacy in-place `conn.auth` mutation in
   * `http-routes.ts → refreshClaimedConnections`.
   */
  setOwnerUserIdForAgent(
    agentId: AgentId,
    ownerUserId: UserId,
  ): Effect.Effect<void> {
    return Ref.update(this.connectionsRef, (map) => {
      let next = map;
      for (const conn of HashMap.values(map)) {
        if (conn._tag === "AgentConnection" && conn.auth.agentId === agentId) {
          next = HashMap.set(
            next,
            conn.connId,
            new AgentConnection({
              connId: conn.connId,
              socket: conn.socket,
              originator: conn.originator,
              conversationIds: conn.conversationIds,
              auth: new AgentContext({
                agentId: conn.auth.agentId,
                agentStatus: conn.auth.agentStatus,
                ownerUserId,
              }),
            }),
          );
        }
      }
      return next;
    });
  }

  /**
   * Add `conversationId` to the subscription set of every currently-connected
   * agent arm in `agentIds`. Idempotent (Set semantics); returns the
   * subscribed connection ids for observability. Replaces the legacy
   * `subscribeAgentsToConversation`. The arm's `conversationIds` Set is
   * mutated in place (the `Data.TaggedClass` field is a `readonly` reference
   * to a mutable Set — the reference never changes, matching the legacy
   * per-connection cache mutation).
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
   * persisted `conversation_participants` rows at connect time (§5.2). No-op
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
