import type { RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect } from "effect";
import type { AgentKey } from "#identity/agents";
import { messagesAuthorize } from "#message";
import { dispatchAuthorize } from "#message/dispatch";
import { agentConnect, PROTOCOL_VERSION } from "#network";
import type { agentCallableGroup } from "#socket/catalog";
import { taskCreate } from "#task";
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
  openProtocolAgentClientSocket,
  RPC_TIMEOUT_MS,
  type RpcCallOptions,
  ProtocolClientLifecycle,
  type ReverseCallbackHandlers,
} from "./lifecycle.js";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof agentCallableGroup>;
type AgentCallableTag = AgentCallableRpcs["_tag"];
type AgentClientDispatch = TypedDispatchMap<AgentCallableRpcs, RpcClientError>;

const makeAgentCallbackHandlers = (): ReverseCallbackHandlers => {
  const reject = (method: string) => () =>
    Effect.dieMessage(`agent client received unexpected callback ${method}`);
  return {
    [dispatchAuthorize.name]: reject(dispatchAuthorize.name),
    [messagesAuthorize.name]: reject(messagesAuthorize.name),
    [taskCreate.name]: reject(taskCreate.name),
  };
};

/** Configures agent client. */
export interface AgentClientOptions {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
}

/** Implements molt zap agent client. */
export class MoltZapAgentClient extends ProtocolClientLifecycle<
  AgentCallableRpcs,
  AgentClientDispatch
> {
  constructor(options: AgentClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: agentConnect.name,
      connectPayload: {
        agentKey: options.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession: openProtocolAgentClientSocket,
      callbackHandlers: makeAgentCallbackHandlers,
      onDisconnect: options.onDisconnect,
    });
  }

  call<Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    SuccessForTag<AgentCallableRpcs, Tag>,
    ErrorForTag<AgentCallableRpcs, Tag> | NotConnectedError | RpcTimeoutError
  > {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.callEffect(tag, payload, timeoutMs);
  }
}
