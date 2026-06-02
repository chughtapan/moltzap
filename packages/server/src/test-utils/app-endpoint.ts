/**
 * @file Test-only {@link AppEndpoint} builders for AppHost unit tests.
 *
 * Production code no longer mints in-process app endpoints: the
 * boot-installed default app declares no hooks and is served entirely by
 * AppHost's manifest-default fast-path (see
 * `app/default-app.ts → makeDefaultAppEndpoint`). These builders exist so
 * AppHost unit tests can still exercise the HOOK-DECLARING dispatch path —
 * a manifest with a declared hook routes through `AppHost.callAppRpc →
 * sendRpcToClient(entry.endpoint.originator, …)`, which needs a concrete
 * originator to dispatch into.
 *
 * Two shapes:
 *   - {@link makeHandlerAppEndpoint} — `originator.call` dispatches to
 *     in-process handlers keyed by RPC name. Use when the test asserts a
 *     verdict round-trips through a registered hook.
 *   - {@link makeInertAppEndpoint} — every dispatch method defects (or an
 *     optional `originatorCall` override mocks the channel, e.g. to simulate
 *     a stale `NotConnectedError`). Use for registration-surface tests that
 *     never drive a hook round-trip.
 */
import { Effect } from "effect";
import type {
  AnyAppCallbackRpcDefinition,
  ParamsOf,
  RpcCallError,
  ResultOf,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { AppEndpoint } from "../app/app-registration.js";
import type { Originator } from "../transport/connection.js";

/**
 * In-process handler for one task-callback RPC. The handler returns
 * the wire-shape result for the matching definition; no encode/decode
 * loop since both sides live in-process.
 */
type AppEndpointHandler<D extends AnyAppCallbackRpcDefinition> = (
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, RpcCallError>;

/**
 * Mapped over the closed `AnyAppCallbackRpcDefinition` union, keyed
 * by each definition's wire name. Mandates one handler per
 * task-callback RPC at construction time — adding a new entry to
 * `appCallbackMethods` becomes a compile error at every endpoint
 * construction site.
 */
export type AppEndpointHandlers = {
  readonly [D in AnyAppCallbackRpcDefinition as D["name"]]: AppEndpointHandler<D>;
};

function defectingOp(id: ConnectionId, label: string, op: string) {
  return Effect.die(
    new Error(
      `${label} connection ${id}: ${op} is not implemented (no inbound dispatch)`,
    ),
  );
}

/**
 * Build an {@link AppEndpoint} whose outbound `originator.call` dispatches to
 * in-process handlers instead of going over a WebSocket. The endpoint
 * satisfies the same `{ connId, originator }` shape a wire-registered app's
 * arm carries so `AppHost`, `AppRegistry`, and `sendRpcToClient` see ONE shape.
 *
 *   - `originator.call(D, params)` indexes `handlers` by `D.name`. The
 *     mapped type guarantees every member of `AnyAppCallbackRpcDefinition`
 *     has a handler — no runtime "method not found" branch exists.
 *   - `originator.notify` / `failAllPending` are no-ops.
 *   - `originator.handle` / `originator.resolve` defect — an in-process
 *     endpoint never receives inbound frames; a call here is a wiring bug.
 */
export function makeHandlerAppEndpoint(args: {
  readonly id: ConnectionId;
  readonly handlers: AppEndpointHandlers;
}): AppEndpoint {
  const call = <D extends AnyAppCallbackRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, RpcCallError> => {
    const handler = args.handlers[
      definition.name as D["name"]
    ] as AppEndpointHandler<D>;
    return handler(params);
  };

  return {
    connId: args.id,
    originator: {
      call,
      notify: () =>
        defectingOp(args.id, "handler-endpoint", "originator.notify"),
      sink: {
        parser: undefined as never,
        inject: () =>
          defectingOp(args.id, "handler-endpoint", "originator.sink.inject"),
      },
    } as Originator,
  };
}

/**
 * Minimal {@link AppEndpoint} for tests that only assert the
 * registration surface (connId keying, unregister-side effects, etc.).
 * Every dispatch method defects — tests that actually drive
 * `runMessageAuthorize` / `runDispatchAuthorize` against a declared hook
 * MUST use {@link makeHandlerAppEndpoint} (or a real wire connection via
 * `acquireConnectionRpcClient`).
 *
 * Optional `originatorCall` override lets a test mock the outbound
 * RPC channel (e.g., to simulate a stale-connection `NotConnectedError`
 * without spinning up a real socket).
 */
export function makeInertAppEndpoint(args: {
  readonly id: ConnectionId;
  readonly originatorCall?: <D extends AnyAppCallbackRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
}): AppEndpoint {
  const call =
    args.originatorCall ??
    (() => defectingOp(args.id, "inert", "originator.call"));
  return {
    connId: args.id,
    originator: {
      call,
      notify: () => defectingOp(args.id, "inert", "originator.notify"),
      sink: {
        parser: undefined as never,
        inject: () => defectingOp(args.id, "inert", "originator.sink.inject"),
      },
    } as Originator,
  };
}
