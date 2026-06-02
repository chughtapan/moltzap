import { Effect } from "effect";
import type { ConnectionId } from "@moltzap/protocol/network";
import type * as Socket from "@effect/platform/Socket";
import type { AgentId } from "../app/types.js";
import { AgentContext, type AgentStatus } from "./context.js";
import type { ConnectionManager, Originator } from "./connection.js";

type SocketWrite = (raw: string) => Effect.Effect<void, Socket.SocketError>;

/**
 * An {@link Originator} stub whose `notify` mirrors production: it encodes the
 * notification to its JSON-RPC wire frame and writes it through the arm's
 * recording `socket.write`, so fan-out tests observe pushed notifications on
 * the same channel a real client would receive them. `call` and `sink` stay
 * defect-throwing — the seeded arms never drive the appCallback or
 * inbound-dispatch paths, and a stray invocation should surface loudly.
 */
const recordingOriginator = (write: SocketWrite): Originator => ({
  call: () => Effect.die("test fake originator.call invoked"),
  notify: (definition, params) =>
    write(JSON.stringify({ method: definition.name, params })).pipe(
      Effect.catchAll(() => Effect.void),
    ),
  sink: {
    parser: undefined as never,
    inject: () => Effect.die("test fake originator.sink.inject invoked"),
  },
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
      recordingOriginator(args.write),
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
      recordingOriginator(args.write),
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
