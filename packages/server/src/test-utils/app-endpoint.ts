/**
 * @file Test-only {@link AppEndpoint} builders for AppEndpointRegistry unit tests.
 *
 * These builders let domain authorization tests exercise manifests that choose
 * `kind: "hook"`, which need a concrete originator to dispatch into.
 *
 * Two shapes:
 *   - {@link makeHandlerAppEndpoint} — `originator.callback` dispatches to
 *     in-process handlers keyed by RPC name. Use when the test asserts a
 *     verdict round-trips through a registered hook.
 */
import { Effect } from "effect";
import type { AnyAppCallbackRpcDefinition } from "@moltzap/protocol/socket/catalog";
import {
  type ReverseCallbackError,
  type ReverseCallbackPayload,
  type ReverseCallbackRequest,
  type ReverseCallbackSuccess,
  isDispatchAuthorizeRequest,
  isMessagesAuthorizeRequest,
  isTaskCreateRequest,
  type ConnectionId,
  type ReverseCallError,
} from "@moltzap/protocol/socket";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize } from "@moltzap/protocol/message";
import { taskCreate } from "@moltzap/protocol/task";
import type { RpcSerialization } from "@effect/rpc";
import type { AppEndpoint } from "#identity/apps";
import type { Originator } from "#socket";

/**
 * In-process handler for one task-callback RPC. The handler returns
 * the wire-shape result for the matching definition; no encode/decode
 * loop since both sides live in-process.
 */
type AppEndpointHandler<D extends AnyAppCallbackRpcDefinition> = (
  params: ReverseCallbackPayload<D>,
) => Effect.Effect<
  ReverseCallbackSuccess<D>,
  ReverseCallbackError<D> | ReverseCallError
>;

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

function makeInertParser(
  id: ConnectionId,
  label: string,
): RpcSerialization.Parser {
  const fail = () =>
    Effect.runSync(
      Effect.dieMessage(
        `${label} connection ${id}: parser is not implemented (no inbound dispatch)`,
      ),
    );
  return {
    decode: fail,
    encode: fail,
  };
}

/**
 * Build an {@link AppEndpoint} whose outbound `originator.call` dispatches to
 * in-process handlers instead of going over a WebSocket. The endpoint
 * satisfies the same `{ connId, originator }` shape a connected app's
 * arm carries so `AppEndpointRegistry`, `AppRegistry`, and `sendRpcToClient` see ONE shape.
 *
 *   - `originator.callback({ definition, params })` indexes `handlers` by
 *     `definition.name`. The
 *     mapped type guarantees every member of `AnyAppCallbackRpcDefinition`
 *     has a handler — no runtime "method not found" branch exists.
 *   - `originator.notify` / `failAllPending` are no-ops.
 *   - `originator.handle` / `originator.resolve` defect — an in-process
 *     endpoint never receives inbound frames; a call here is a wiring bug.
 * @param args Value supplied to the operation.
 * @param args.id Value supplied to the operation.
 * @param args.handlers Value supplied to the operation.
 * @returns The created handler app endpoint.
 */
export function makeHandlerAppEndpoint(args: {
  readonly id: ConnectionId;
  readonly handlers: AppEndpointHandlers;
}): AppEndpoint {
  const defect = (op: string) => defectingOp(args.id, "handler-endpoint", op);
  const callback = (
    request: ReverseCallbackRequest,
  ): ReturnType<Originator["callback"]> => {
    if (isDispatchAuthorizeRequest(request)) {
      return args.handlers[dispatchAuthorize.name](request.params);
    }
    if (isMessagesAuthorizeRequest(request)) {
      return args.handlers[messagesAuthorize.name](request.params);
    }
    if (isTaskCreateRequest(request)) {
      return args.handlers[taskCreate.name](request.params);
    }
    return defect("originator.callback");
  };
  const originator: Originator = {
    call: () => defect("originator.call"),
    callback,
    notify: () => defect("originator.notify"),
    sink: {
      parser: makeInertParser(args.id, "handler-endpoint"),
      inject: () => defect("originator.sink.inject"),
    },
  };

  return {
    connId: args.id,
    originator,
  };
}
