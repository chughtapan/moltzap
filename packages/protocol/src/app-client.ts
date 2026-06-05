import type { Rpc, RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect } from "effect";
import type {
  AppCallbackHandlers,
  AppCallbackRpcDefinition,
  HandlerSlot,
} from "./app/methods.js";
import type { AppKey } from "./credentials.js";
import { AppConnect, PROTOCOL_VERSION } from "./network/connect.js";
import { AppCallableGroup } from "./rpc-method-groups.js";
import { type CloseInfo } from "./close-info.js";
import { NotConnectedError, RpcTimeoutError } from "./transport/rpc-errors.js";
import {
  openProtocolAppClientSocket,
  RPC_TIMEOUT_MS,
  type ConnectResult,
  type RpcCallOptions,
  ProtocolClientLifecycle,
  type ReverseCallbackHandlers,
} from "./client-lifecycle.js";
import {
  type ErrorForTag,
  type PayloadForTag,
  type SuccessForTag,
  type TypedDispatchMap,
} from "./transport/typed-dispatch.js";

type AppCallableRpcs = RpcGroup.Rpcs<typeof AppCallableGroup>;
type AppCallableTag = AppCallableRpcs["_tag"];
type AppClientDispatch = TypedDispatchMap<AppCallableRpcs, RpcClientError>;

export interface AppCallbackContext {
  readonly requestId: string;
}

const CALLBACK_CONTEXT: AppCallbackContext = {
  requestId: "reverse-rpc",
};

function isCallbackParams<D extends AppCallbackRpcDefinition>(
  slot: HandlerSlot<D, AppCallbackContext>,
  params: unknown,
): params is Parameters<HandlerSlot<D, AppCallbackContext>["handle"]>[0] {
  return slot.definition.validateParams(params);
}

function makeAppCallbackHandlers(
  handlers: AppCallbackHandlers<AppCallbackContext>,
): ReverseCallbackHandlers {
  const adapt =
    <D extends AppCallbackRpcDefinition>(
      slot: HandlerSlot<D, AppCallbackContext>,
    ) =>
    (params: Rpc.Payload<D["clientRpc"]>) => {
      if (!isCallbackParams(slot, params)) {
        return Effect.die(
          new Error(`Invalid callback payload for ${slot.definition.name}`),
        );
      }
      return slot.handle(params, CALLBACK_CONTEXT);
    };
  return {
    "dispatch/authorize": adapt(handlers["dispatch/authorize"]),
    "messages/authorize": adapt(handlers["messages/authorize"]),
    "task/create": adapt(handlers["task/create"]),
  };
}

export interface AppClientOptions {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly onReconnect?: (helloOk: ConnectResult) => void;
  readonly handlers: AppCallbackHandlers<AppCallbackContext>;
}

export class MoltZapAppClient extends ProtocolClientLifecycle<
  AppCallableRpcs,
  AppClientDispatch
> {
  constructor(options: AppClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: AppConnect.name,
      connectPayload: {
        appKey: options.appKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAppClientSocket,
      callbackHandlers: () => makeAppCallbackHandlers(options.handlers),
      onDisconnect: options.onDisconnect,
      onReconnect: options.onReconnect,
      failConnectWhenClosed: true,
    });
  }

  call<Tag extends AppCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AppCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    SuccessForTag<AppCallableRpcs, Tag>,
    ErrorForTag<AppCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.callEffect(tag, payload, timeoutMs);
  }
}
