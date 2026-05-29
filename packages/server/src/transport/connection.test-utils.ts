import { Effect } from "effect";
import type { ServerConnection } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type * as Socket from "@effect/platform/Socket";
import type { AgentId } from "../app/types.js";
import { AgentContext, type AgentStatus } from "./context.js";
import type { ConnectionManager } from "./connection.js";
import type { DispatchContext } from "./context.js";

/**
 * Defect-throwing `ServerConnection&lt;DispatchContext>` stub for the arm
 * seeders below — the seeded arms never exercise the appCallback channel
 * or the inbound-dispatch path. If a test inadvertently drives any method
 * the defect surfaces loudly rather than silently passing. Module-private:
 * the seeders are the only consumers.
 */
const unusedOriginator = (): ServerConnection<DispatchContext> => ({
  id: "test-fake-originator",
  call: () => Effect.die("test fake originator.call invoked"),
  resolve: () => Effect.die("test fake originator.resolve invoked"),
  failAllPending: () =>
    Effect.die("test fake originator.failAllPending invoked"),
  notify: (() => Effect.die("test fake originator.notify invoked")) as never,
  handle: () => Effect.die("test fake originator.handle invoked"),
});

/**
 * D #705 CP4e — seed an UNAUTHENTICATED-arm connection into a
 * `ConnectionManager`'s three-arm `connectionsRef`. The minted arm's
 * `socket.write` is the `write` passed here. Used by fan-out tests that only
 * need a connection to RECEIVE frames (presence subscribers), where the
 * principal arm is irrelevant.
 */
export const seedUnauthenticatedConnection = (args: {
  readonly manager: ConnectionManager;
  readonly connId: ConnectionId;
  readonly write: (raw: string) => Effect.Effect<void, Socket.SocketError>;
  readonly shutdown?: Effect.Effect<void>;
}): Effect.Effect<void> =>
  args.manager
    .addUnauthenticated(
      args.connId,
      { write: args.write, shutdown: args.shutdown ?? Effect.void },
      unusedOriginator(),
    )
    .pipe(Effect.withSpan("seedUnauthenticatedConnection"));

/**
 * D #705 CP4e — seed an authenticated AGENT-arm connection into a
 * `ConnectionManager`'s three-arm `connectionsRef`. The arm constructors are
 * module-private, so tests construct arms through the sanctioned
 * `addUnauthenticated` → `authenticate` transition (the same path production
 * takes). The minted arm's `socket.write` is the `write` passed here.
 */
export const seedAgentConnection = (args: {
  readonly manager: ConnectionManager;
  readonly connId: ConnectionId;
  readonly agentId: AgentId;
  readonly write: (raw: string) => Effect.Effect<void, Socket.SocketError>;
  readonly shutdown?: Effect.Effect<void>;
  readonly status?: AgentStatus;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* args.manager.addUnauthenticated(
      args.connId,
      { write: args.write, shutdown: args.shutdown ?? Effect.void },
      unusedOriginator(),
    );
    yield* args.manager.authenticate(
      args.connId,
      new AgentContext({
        agentId: args.agentId,
        agentStatus: args.status ?? "active",
        ownerUserId: null,
      }),
    );
  }).pipe(Effect.withSpan("seedAgentConnection"));
