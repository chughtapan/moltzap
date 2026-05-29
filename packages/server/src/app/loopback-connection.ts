import { Effect } from "effect";
import type {
  AnyTaskCallbackRpcDefinition,
  ParamsOf,
  RpcCallError,
  ResultOf,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { AppEndpoint } from "./app-registration.js";
import type { Originator } from "../transport/connection.js";

/**
 * In-process handler for one task-callback RPC. The handler returns
 * the wire-shape result for the matching definition; no encode/decode
 * loop since both sides live in-process.
 */
type LoopbackHandler<D extends AnyTaskCallbackRpcDefinition> = (
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, RpcCallError>;

/**
 * Mapped over the closed `AnyTaskCallbackRpcDefinition` union, keyed
 * by each definition's wire name. Mandates one handler per
 * task-callback RPC at construction time — adding a new entry to
 * `taskCallbackMethods` becomes a compile error at every loopback
 * construction site (which is the right blast radius for "I added a
 * new server→app RPC; who needs to handle it?").
 */
export type LoopbackHandlers = {
  readonly [D in AnyTaskCallbackRpcDefinition as D["name"]]: LoopbackHandler<D>;
};

function defectingOp(id: ConnectionId, label: string, op: string) {
  return Effect.die(
    new Error(
      `${label} connection ${id}: ${op} is not implemented (no inbound dispatch)`,
    ),
  );
}

/**
 * TEST-ONLY. Build an {@link AppEndpoint} whose outbound `originator.call`
 * dispatches to in-process handlers instead of going over a WebSocket. The
 * endpoint satisfies the same `{ connId, originator }` shape a wire-registered
 * app's arm carries so `AppHost`, `AppRegistry`, and `sendRpcToClient` see ONE
 * shape. Used by AppHost unit tests to exercise the hook-declaring dispatch
 * path without a real socket; production code (the boot-installed default app)
 * declares no hooks and is served by AppHost's manifest-default fast-path
 * (see `default-app.ts → makeDefaultAppEndpoint`).
 *
 * Loopback-specific behavior:
 *   - `originator.call(D, params)` indexes `handlers` by `D.name`. The
 *     mapped type guarantees every member of
 *     `AnyTaskCallbackRpcDefinition` has a handler — no runtime
 *     "method not found" branch exists.
 *   - `originator.notify` / `failAllPending` are no-ops (the default
 *     app doesn't subscribe to notifications and has no pending
 *     Deferreds to drain).
 *   - `originator.handle` / `originator.resolve` defect — a loopback
 *     never receives inbound frames; if anyone calls these, it's a
 *     wiring bug that should crash the server immediately.
 */
export function makeLoopbackConnection(args: {
  readonly id: ConnectionId;
  readonly handlers: LoopbackHandlers;
}): AppEndpoint {
  const call = <D extends AnyTaskCallbackRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, RpcCallError> => {
    const handler = args.handlers[
      definition.name as D["name"]
    ] as LoopbackHandler<D>;
    return handler(params);
  };

  return {
    connId: args.id,
    originator: {
      id: args.id,
      call,
      notify: () => Effect.void,
      failAllPending: () => Effect.void,
      handle: () => defectingOp(args.id, "loopback", "originator.handle"),
      resolve: () => defectingOp(args.id, "loopback", "originator.resolve"),
    } as Originator,
  };
}

/**
 * Minimal {@link AppEndpoint} for tests that only assert the
 * registration surface (connId keying, unregister-side effects, etc.).
 * Every dispatch method defects —
 * tests that actually drive `runMessageAuthorize` /
 * `runDispatchAuthorize` MUST use {@link makeLoopbackConnection}
 * (or, in app-host integration tests, a real wire connection via
 * `acquireConnectionRpcClient`).
 *
 * Optional `originatorCall` override lets a test mock the outbound
 * RPC channel (e.g., to simulate a stale-connection
 * `NotConnectedError` without spinning up a real socket).
 */
export function makeStubConnection(args: {
  readonly id: ConnectionId;
  readonly originatorCall?: <D extends AnyTaskCallbackRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
}): AppEndpoint {
  const call =
    args.originatorCall ??
    (() => defectingOp(args.id, "stub", "originator.call"));
  return {
    connId: args.id,
    originator: {
      id: args.id,
      call,
      notify: () => Effect.void,
      failAllPending: () => Effect.void,
      handle: () => defectingOp(args.id, "stub", "originator.handle"),
      resolve: () => defectingOp(args.id, "stub", "originator.resolve"),
    } as Originator,
  };
}
