/**
 * @file Test-only {@link AppEndpoint} builders for AppHost unit tests.
 *
 * The boot-installed default app declares a required `hooks` block whose
 * policies are all static. AppHost resolves those policies in-process.
 * These builders let AppHost unit tests exercise manifests that choose
 * `kind: "hook"`, which need a concrete originator to dispatch into.
 *
 * Two shapes:
 *   - {@link makeHandlerAppEndpoint} — `originator.callback` dispatches to
 *     in-process handlers keyed by RPC name. Use when the test asserts a
 *     verdict round-trips through a registered hook.
 */
import { Effect } from "effect";
import type { AnyAppCallbackRpcDefinition } from "@moltzap/protocol/socket";
import type {
  ReverseCallbackError,
  ReverseCallbackPayload,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
} from "@moltzap/protocol/socket";
import { DispatchAuthorize } from "@moltzap/protocol/dispatch";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import { TaskCreate } from "@moltzap/protocol/task";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { RpcSerialization } from "@effect/rpc";
import type { AppEndpoint } from "../app/app-registration.js";
import type { Originator } from "../transport/connection.js";
import type { ReverseCallError } from "@moltzap/protocol/socket";

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

type DispatchAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof DispatchAuthorize }
>;
type MessagesAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof MessagesAuthorize }
>;
type TaskCreateRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof TaskCreate }
>;

const isDispatchAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is DispatchAuthorizeRequest =>
  request.definition === DispatchAuthorize;

const isMessagesAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is MessagesAuthorizeRequest =>
  request.definition === MessagesAuthorize;

const isTaskCreateRequest = (
  request: ReverseCallbackRequest,
): request is TaskCreateRequest => request.definition === TaskCreate;

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
 * arm carries so `AppHost`, `AppRegistry`, and `sendRpcToClient` see ONE shape.
 *
 *   - `originator.callback({ definition, params })` indexes `handlers` by
 *     `definition.name`. The
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
  const callback = (
    request: ReverseCallbackRequest,
  ): ReturnType<Originator["callback"]> => {
    if (isDispatchAuthorizeRequest(request)) {
      return args.handlers[DispatchAuthorize.name](request.params);
    }
    if (isMessagesAuthorizeRequest(request)) {
      return args.handlers[MessagesAuthorize.name](request.params);
    }
    if (isTaskCreateRequest(request)) {
      return args.handlers[TaskCreate.name](request.params);
    }
    return defectingOp(args.id, "handler-endpoint", "originator.callback");
  };
  const originator: Originator = {
    call: () => defectingOp(args.id, "handler-endpoint", "originator.call"),
    callback,
    notify: () => defectingOp(args.id, "handler-endpoint", "originator.notify"),
    sink: {
      parser: makeInertParser(args.id, "handler-endpoint"),
      inject: () =>
        defectingOp(args.id, "handler-endpoint", "originator.sink.inject"),
    },
  };

  return {
    connId: args.id,
    originator,
  };
}
