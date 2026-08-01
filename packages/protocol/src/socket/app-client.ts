import type { RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import type { Effect } from "effect";
import type { AppKey } from "#identity/apps";
import { appConnect, PROTOCOL_VERSION } from "#network";
import type { appCallableGroup } from "#socket/catalog";
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
} from "./lifecycle.js";

type AppCallableRpcs = RpcGroup.Rpcs<typeof appCallableGroup>;
type AppCallableTag = AppCallableRpcs["_tag"];
type AppClientDispatch = TypedDispatchMap<AppCallableRpcs, RpcClientError>;

/** Configures app client. */
export interface AppClientOptions {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
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
