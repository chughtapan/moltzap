// safer-arch-ignore no-cross-domain-sibling-import: The connection handshake is an adapter boundary that authenticates principals and registers their domain services atomically.
import { Data, Effect, Match, Option } from "effect";
import {
  type agentConnect,
  PROTOCOL_VERSION,
  checkProtocolRange,
  type HelloOk,
} from "@moltzap/protocol/network";
import {
  UnauthorizedError,
  type ParamsOf,
  InvalidParamsError,
} from "@moltzap/protocol/rpc";
import type { AgentKey } from "@moltzap/protocol/identity";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import {
  agentContextFrom,
  type AgentContext,
  ConnectionManagerTag,
  ConnectionTag,
  type Connection,
  type ConnectionManager,
} from "#socket";
import { ConnectionHooksTag } from "../core/hooks.js";
import { DbTag } from "#db";
import { AuthServiceTag } from "../identity/agents/layer.js";
import type { AuthService } from "../identity/agents/auth.service.js";
import { ConversationServiceTag } from "../conversation/layer.js";
import type { ConversationService } from "../conversation/conversation.service.js";
import { AgentEndpointResolverTag } from "./layer.js";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { AgentEndpointResolver } from "./agent-endpoint-resolver.js";

type AgentConnectParams = ParamsOf<typeof agentConnect>;

/** The empty HelloOk — success is the only payload. */
const HELLO_OK: HelloOk = {};

class ConnectionHookError extends Data.TaggedError("ConnectionHookError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Agent API-key path — mints the closed-union `AgentContext` arm directly.
 * @param agentKey Value supplied to the operation.
 * @param authService Value supplied to the operation.
 * @returns The authenticate agent key result.
 */
const authenticateAgentKey = Effect.fn("connect.authenticateAgentKey")(
  function* (agentKey: AgentKey, authService: AuthService) {
    const agent = yield* authService.authenticateAgent(agentKey);
    if (!agent) {
      return yield* new UnauthorizedError({ message: "Authentication failed" });
    }
    return yield* agentContextFrom({
      agentId: agent.agentId,
      agentStatus: agent.status,
      ownerUserId: agent.ownerUserId,
    });
  },
);

const hydrateConnectionState = Effect.fn("connect.hydrateConnectionState")(
  function* (
    connections: ConnectionManager,
    connId: ConnectionId,
    auth: AgentContext,
    conversationService: ConversationService,
  ) {
    const convIds = yield* conversationService.getConversationIds(auth.agentId);
    // Seed the agent arm's conversation membership cache. The arm was minted
    // by `mirrorAgentArmTransition` just above, so it exists for this connId.
    yield* connections.hydrateConversationIds(connId, convIds);
  },
);

const registerEndpointIfStillConnected = Effect.fn(
  "connect.registerEndpointIfStillConnected",
)(function* (
  connections: ConnectionManager,
  resolver: AgentEndpointResolver,
  connId: ConnectionId,
  auth: AgentContext,
) {
  // Read the live `connectionsRef` arm before registering the endpoint.
  if (Option.isSome(yield* connections.peek(connId))) {
    yield* resolver.add(auth.agentId, connId);
  }
});

/**
 * Mint the agent arm onto the `connectionsRef` via the
 * immutable transition. The `AgentContext` is resolved directly by the
 * authenticators (no `AuthenticatedContext` intermediary), so this passes it
 * straight to `authenticate`. All `TransitionOutcome` arms are matched
 * exhaustively. `not-connected` is a benign race (the close handler removed the
 * entry); `already-connected` is the re-auth no-op (a fresh `HelloOk`).
 * @param connections Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @param auth Value supplied to the operation.
 * @returns The mirror agent arm transition result.
 */
function mirrorAgentArmTransition(
  connections: ConnectionManager,
  connId: ConnectionId,
  auth: AgentContext,
): Effect.Effect<void> {
  return connections.authenticate(connId, auth).pipe(
    Effect.flatMap((outcome) =>
      Match.value(outcome).pipe(
        Match.when({ kind: "ok-agent" }, () => Effect.void),
        Match.when({ kind: "already-connected" }, () => Effect.void),
        Match.when({ kind: "not-connected" }, () => Effect.void),
        Match.exhaustive,
      ),
    ),
  );
}

/**
 * Agent post-auth flow. Resolves the `moltzap_agent_`-prefixed credential to an
 * `AgentContext`, mints the agent arm via the immutable transition, hydrates
 * the conversation-id subscription set + agent-endpoint registration, then
 * emits the empty `HelloOk`.
 * @param credential Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @returns The complete agent connect result.
 */
const completeAgentConnect = Effect.fn("connect.completeAgentConnect")(
  function* (credential: AgentKey, connId: ConnectionId) {
    const authService = yield* AuthServiceTag;
    const conversationService = yield* ConversationServiceTag;
    const connections = yield* ConnectionManagerTag;
    const agentEndpointResolver = yield* AgentEndpointResolverTag;

    const auth = yield* authenticateAgentKey(credential, authService);
    // The agent arm is minted by the immutable transition below; the
    // arm IS the auth store.
    yield* mirrorAgentArmTransition(connections, connId, auth);
    yield* hydrateConnectionState(
      connections,
      connId,
      auth,
      conversationService,
    );
    yield* registerEndpointIfStillConnected(
      connections,
      agentEndpointResolver,
      connId,
      auth,
    );
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- connection hooks run after module initialization.
    yield* fireConnectionHooks(auth, connId);
    return HELLO_OK;
  },
);

/**
 * Fire every registered connection hook for a freshly-authenticated agent arm.
 * Hooks carry `agentId`, the agent's display name (DB lookup, falling back to
 * the id), `ownerUserId`, and `connId`. Each runs with a 2-second timeout;
 * a throw or timeout is logged and does not fail the Connect.
 * @param auth Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @returns The fire connection hooks result.
 */
const fireConnectionHooks = Effect.fn("connect.fireConnectionHooks")(function* (
  auth: AgentContext,
  connId: ConnectionId,
) {
  const hooks = yield* ConnectionHooksTag;
  if (hooks.connectionHooks.length === 0) {
    return;
  }
  const db = yield* DbTag;
  const row = yield* Effect.tryPromise(() =>
    db
      .selectFrom("agents")
      .select("name")
      .where("id", "=", auth.agentId)
      .executeTakeFirst(),
  ).pipe(Effect.orElseSucceed(() => undefined));
  const agentName = row?.name ?? auth.agentId;
  for (const hook of hooks.connectionHooks) {
    yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          hook({
            agentId: auth.agentId,
            agentName,
            ownerUserId: auth.ownerUserId,
            connId,
          }),
        ),
      catch: (cause) =>
        new ConnectionHookError({
          message: "Connection hook failed",
          cause,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: "2 seconds",
        onTimeout: () =>
          new ConnectionHookError({ message: "Connection hook timed out" }),
      }),
      Effect.catchAll((err) =>
        Effect.logWarning("Connection hook error").pipe(
          Effect.annotateLogs({ err, agentId: auth.agentId, connId }),
        ),
      ),
    );
  }
});

function checkConnectProtocol(params: AgentConnectParams) {
  // Protocol-range gate runs BEFORE auth resolution: clients outside the
  // supported version range are rejected at the version edge, so no partial
  // state leaks before the rejection. A malformed `min/maxProtocol` string
  // maps to the wire-typed `InvalidParamsError` (JSON-RPC -32602).
  return checkProtocolRange(params, PROTOCOL_VERSION).pipe(
    Effect.catchTag("InvalidProtocolVersionError", (cause) =>
      Effect.fail(
        new InvalidParamsError({
          message: `Malformed protocol version ${JSON.stringify(cause.version)}: invalid segment ${JSON.stringify(cause.segment)}`,
        }),
      ),
    ),
  );
}

const reemitHelloIfAuthenticated = Effect.fn(
  "connect.reemitHelloIfAuthenticated",
)(function* (conn: Connection) {
  if (conn._tag === "AgentConnection") {
    yield* fireConnectionHooks(conn.auth, conn.connId);
    return Option.some(HELLO_OK);
  }
  return Option.none<HelloOk>();
});

/**
 * Connect preamble: gate the protocol range, then re-emit `HelloOk` for an
 * already-authenticated arm (idempotent re-auth). Returns the live connection
 * plus `Some(helloOk)` when the caller short-circuits, `None` when it should
 * run the credential authentication.
 * @param params Request payload to process.
 * @returns The connect preamble result.
 */
function connectPreamble(params: AgentConnectParams) {
  return Effect.gen(function* () {
    yield* checkConnectProtocol(params);
    const conn = yield* ConnectionTag;
    const reemitted = yield* reemitHelloIfAuthenticated(conn);
    return { conn, reemitted };
  });
}

const handleAgentConnect = Effect.fn("agent.connect")(function* (
  params: AgentConnectParams,
) {
  const { conn, reemitted } = yield* connectPreamble(params);
  if (Option.isSome(reemitted)) {
    return reemitted.value;
  }

  return yield* completeAgentConnect(params.agentKey, conn.connId);
});

// ── @effect/rpc handler bodies ────────────────────────────────────────
//
// `agent/network/connect` is the only unauthenticated method. The body unwraps
// the redacted key at the auth-service boundary.
/**
 * Provides the connect agent runtime value.
 * @param params Request payload to process.
 * @returns The connect agent result.
 */
export const connectAgent: ServerHandler<typeof agentConnect> = (params) =>
  handleAgentConnect(params).pipe(Effect.withSpan("connect.agent"));

// safer-arch-ignore no-fat-orchestrator: Connect handlers coordinate authentication, connection-arm transitions, and endpoint registration as one atomic handshake boundary.
