import type { Rpc, RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect } from "effect";
import type { AppCallbackHandlers, HandlerSlot } from "./app-callbacks.js";
import type { AppKey } from "#identity/apps";
import { messagesAuthorize } from "#message";
import { dispatchAuthorize } from "#message/dispatch";
import { appConnect, PROTOCOL_VERSION } from "#network";
import type {
  appCallableGroup,
  AnyAppCallbackRpcDefinition,
} from "#socket/catalog";
import type { CloseInfo } from "./close-info.js";
import type {
  ErrorForTag,
  NotConnectedError,
  PayloadForTag,
  RpcTimeoutError,
  SuccessForTag,
  TypedDispatchMap,
} from "#transport";
import {
  openProtocolAppClientSocket,
  RPC_TIMEOUT_MS,
  type RpcCallOptions,
  ProtocolClientLifecycle,
  type ReverseCallbackHandlers,
} from "./lifecycle.js";
import { taskCreate } from "#task";

type AppCallableRpcs = RpcGroup.Rpcs<typeof appCallableGroup>;
type AppCallableTag = AppCallableRpcs["_tag"];
type AppClientDispatch = TypedDispatchMap<AppCallableRpcs, RpcClientError>;

/** Carries context for app callback. */
export interface AppCallbackContext {
  readonly requestId: string;
}

const CALLBACK_CONTEXT: AppCallbackContext = {
  requestId: "reverse-rpc",
};

function isCallbackParams<D extends AnyAppCallbackRpcDefinition>(
  slot: HandlerSlot<D, AppCallbackContext>,
  params: unknown,
): params is Parameters<HandlerSlot<D, AppCallbackContext>["handle"]>[0] {
  return slot.definition.validateParams(params);
}

function makeAppCallbackHandlers(
  handlers: AppCallbackHandlers<AppCallbackContext>,
): ReverseCallbackHandlers {
  const adapt =
    <D extends AnyAppCallbackRpcDefinition>(
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
    [dispatchAuthorize.name]: adapt(handlers[dispatchAuthorize.name]),
    [messagesAuthorize.name]: adapt(handlers[messagesAuthorize.name]),
    [taskCreate.name]: adapt(handlers[taskCreate.name]),
  };
}

/** Configures app client. */
export interface AppClientOptions {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
  readonly handlers: AppCallbackHandlers<AppCallbackContext>;
}

/** Implements molt zap app client. */
export class MoltZapAppClient extends ProtocolClientLifecycle<
  AppCallableRpcs,
  AppClientDispatch
> {
  constructor(options: AppClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: appConnect.name,
      connectPayload: {
        appKey: options.appKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAppClientSocket,
      callbackHandlers: () => makeAppCallbackHandlers(options.handlers),
      onDisconnect: options.onDisconnect,
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
