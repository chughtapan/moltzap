import type { Socket as EffectSocket } from "@effect/platform/Socket";
import { Effect, Layer } from "effect";
import {
  MoltZapServer,
  type ConnectionId,
  type MoltZapServerSession,
} from "@moltzap/protocol/socket";

import type { ResolvedServices } from "#core";
import { ConnectionManagerTag, ConnectionTag } from "#core";
import type { DisconnectionHook } from "#core";
import type { AgentContext } from "./context.js";
import { serverHandlers } from "#core";
import { makeRequirementMiddlewareLayers } from "./auth-middleware-layers.js";
import { peekLiveArm } from "./principal-gate.js";

export function makeCoreSocketHandler(options: {
  readonly services: ResolvedServices;
  readonly disconnectionHooks: readonly DisconnectionHook[];
}) {
  const protocolServer = new MoltZapServer({
    handlers: serverHandlers,
    authLayer: makeRequirementMiddlewareLayers,
    connectionLayer: makeConnectionTagLayer,
    onOpen: (session) =>
      options.services.connections.addUnauthenticated(
        session.connId,
        { write: session.write, shutdown: session.shutdown },
        session.originator,
      ),
    onClose: (_exit, session) => closeSocketSession(session, options),
  });
  return (socket: EffectSocket) => protocolServer.handleSocket(socket);
}

const makeConnectionTagLayer = (
  connId: ConnectionId,
): Layer.Layer<ConnectionTag, never, ConnectionManagerTag> =>
  Layer.effect(
    ConnectionTag,
    ConnectionManagerTag.pipe(
      Effect.flatMap((manager) => peekLiveArm(manager, connId)),
    ),
  );

function closeSocketSession(
  session: MoltZapServerSession,
  options: {
    readonly services: ResolvedServices;
    readonly disconnectionHooks: readonly DisconnectionHook[];
  },
) {
  return Effect.gen(function* () {
    const removed = yield* options.services.connections.removeAndReturn(
      session.connId,
    );
    if (removed !== undefined && removed._tag === "AgentConnection") {
      const authCtx = removed.auth;
      yield* options.services.presenceService.onAgentDisconnect(
        authCtx.agentId,
        session.connId,
      );
      yield* runDisconnectionHooks(authCtx, session, options);
      yield* options.services.agentEndpointResolver.remove(
        authCtx.agentId,
        session.connId,
      );
    }
    yield* options.services.leaseRegistry.abandon(session.connId);
    options.services.presenceService.removeConnection(session.connId);
    options.services.appHost.unregisterAppsForConnection(session.connId);
  }).pipe(Effect.withSpan("socket.closeSession"));
}

function runDisconnectionHooks(
  authCtx: AgentContext,
  session: MoltZapServerSession,
  options: { readonly disconnectionHooks: readonly DisconnectionHook[] },
) {
  return Effect.gen(function* () {
    const { agentId, ownerUserId } = authCtx;
    for (const hook of options.disconnectionHooks) {
      yield* runUserHook(
        hook,
        { agentId, ownerUserId, connId: session.connId },
        "Disconnection hook",
        { agentId, connId: session.connId },
      );
    }
  }).pipe(Effect.withSpan("socket.runDisconnectionHooks"));
}

function runUserHook<TArgs>(
  hook: (args: TArgs) => void | PromiseLike<void>,
  args: TArgs,
  label: string,
  logCtx: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(hook(args)),
    catch: (err) => err,
  }).pipe(
    Effect.timeoutFail({
      duration: "2 seconds",
      onTimeout: () => new Error(`${label} timed out`),
    }),
    Effect.catchAll((err) =>
      Effect.logWarning(`${label} error`).pipe(
        Effect.annotateLogs({ err, ...logCtx }),
      ),
    ),
  );
}
