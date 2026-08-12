// safer-arch-ignore no-trivial-sink-file: This is the protocol socket adapter boundary; core app is intentionally its sole composition consumer.
import type { Socket as EffectSocket } from "@effect/platform/Socket";
import { Effect, Layer } from "effect";
import {
  MoltZapServer,
  type ConnectionId,
  type MoltZapServerSession,
} from "@moltzap/protocol/socket";

import type { ResolvedServices } from "#core";
import { ConnectionManagerTag, ConnectionTag } from "#socket";
import { serverHandlers } from "./handler-catalog.js";
import { makeRequirementMiddlewareLayers } from "./auth-middleware-layers.js";
import { peekLiveArm } from "./principal-gate.js";

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
 * @param options.services Value supplied to the operation.
 * @returns The created moltzap socket handler.
 */
export function makeMoltzapSocketHandler(options: {
  readonly services: ResolvedServices;
}) {
  const protocolServer = new MoltZapServer({
    handlers: serverHandlers,
    authLayer: makeRequirementMiddlewareLayers,
    connectionLayer: makeConnectionTagLayer,
    onOpen: (session) =>
      options.services.connections.addUnauthenticated(
        session.connId,
        session.shutdown,
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
  },
) {
  const removed = yield* options.services.connections.removeAndReturn(
    session.connId,
  );
  if (removed !== undefined && removed._tag === "AgentConnection") {
    const authCtx = removed.auth;
    yield* options.services.agentEndpointResolver.remove(
      authCtx.agentId,
      session.connId,
    );
  }
});
