// safer-arch-ignore no-trivial-sink-file: This is the protocol socket adapter boundary; core app is intentionally its sole composition consumer.
import type { Socket as EffectSocket } from "@effect/platform/Socket";
import { Data, Effect, Layer } from "effect";
import {
  MoltZapServer,
  type ConnectionId,
  type MoltZapServerSession,
} from "@moltzap/protocol/socket";

import type { ResolvedServices, DisconnectionHook } from "#core";
import {
  ConnectionManagerTag,
  ConnectionTag,
  type AgentContext,
} from "#socket";
import { serverHandlers } from "./handler-catalog.js";
import { makeRequirementMiddlewareLayers } from "./auth-middleware-layers.js";
import { peekLiveArm } from "./principal-gate.js";

class UserHookError extends Data.TaggedError("UserHookError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const makeConnectionTagLayer = (
  connId: ConnectionId,
): Layer.Layer<ConnectionTag, never, ConnectionManagerTag> =>
  Layer.effect(
    ConnectionTag,
    ConnectionManagerTag.pipe(
      Effect.flatMap((manager) => peekLiveArm(manager, connId)),
    ),
  );

/**
 * Creates moltzap socket handler.
 * @param options Options that control the operation.
 * @param options.disconnectionHooks Value supplied to the operation.
 * @param options.services Value supplied to the operation.
 * @returns The created moltzap socket handler.
 */
export function makeMoltzapSocketHandler(options: {
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
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lifecycle callback is invoked after module initialization.
    onClose: (...[, session]) => closeSocketSession(session, options),
  });
  return (socket: EffectSocket) => protocolServer.handleSocket(socket);
}

const closeSocketSession = Effect.fn("socket.closeSession")(function* (
  session: MoltZapServerSession,
  options: {
    readonly services: ResolvedServices;
    readonly disconnectionHooks: readonly DisconnectionHook[];
  },
) {
  const removed = yield* options.services.connections.removeAndReturn(
    session.connId,
  );
  if (removed !== undefined && removed._tag === "AgentConnection") {
    const authCtx = removed.auth;
    yield* options.services.presenceService.onAgentDisconnect(
      authCtx.agentId,
      session.connId,
    );
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- hook runner is initialized before the callback executes.
    yield* runDisconnectionHooks(authCtx, session, options);
    yield* options.services.agentEndpointResolver.remove(
      authCtx.agentId,
      session.connId,
    );
  }
  yield* options.services.leaseRegistry.abandon(session.connId);
  options.services.appEndpointRegistry.unregisterAppsForConnection(
    session.connId,
  );
});

const runDisconnectionHooks = Effect.fn("socket.runDisconnectionHooks")(
  function* (
    authCtx: AgentContext,
    session: MoltZapServerSession,
    options: { readonly disconnectionHooks: readonly DisconnectionHook[] },
  ) {
    const { agentId, ownerUserId } = authCtx;
    for (const hook of options.disconnectionHooks) {
      yield* runUserHook(
        hook,
        { agentId, ownerUserId, connId: session.connId },
        "Disconnection hook",
        { agentId, connId: session.connId },
      );
    }
  },
);

function runUserHook<TArgs>(
  hook: (args: TArgs) => undefined | PromiseLike<undefined>,
  args: TArgs,
  label: string,
  logCtx: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(hook(args)),
    catch: (cause) => new UserHookError({ message: `${label} failed`, cause }),
  }).pipe(
    Effect.timeoutFail({
      duration: "2 seconds",
      onTimeout: () => new UserHookError({ message: `${label} timed out` }),
    }),
    Effect.catchAll((err) =>
      Effect.logWarning(`${label} error`).pipe(
        Effect.annotateLogs({ err, ...logCtx }),
      ),
    ),
  );
}
