import type { RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect } from "effect";
import type { AgentKey } from "#identity/agents";
import { MessagesAuthorize } from "#message";
import { DispatchAuthorize } from "#message/dispatch";
import { AgentConnect, PROTOCOL_VERSION } from "#network";
import { AgentCallableGroup } from "#socket/catalog";
import { TaskCreate } from "#task";
import { type CloseInfo } from "./close-info.js";
import { NotConnectedError, RpcTimeoutError } from "#transport";
import {
  openProtocolAgentClientSocket,
  RPC_TIMEOUT_MS,
  type RpcCallOptions,
  ProtocolClientLifecycle,
  type ReverseCallbackHandlers,
} from "./lifecycle.js";
import {
  type ErrorForTag,
  type PayloadForTag,
  type SuccessForTag,
  type TypedDispatchMap,
} from "#transport";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
type AgentCallableTag = AgentCallableRpcs["_tag"];
type AgentClientDispatch = TypedDispatchMap<AgentCallableRpcs, RpcClientError>;

const makeAgentCallbackHandlers = (): ReverseCallbackHandlers => {
  const reject = (method: string) => () =>
    Effect.dieMessage(`agent client received unexpected callback ${method}`);
  return {
    [DispatchAuthorize.name]: reject(DispatchAuthorize.name),
    [MessagesAuthorize.name]: reject(MessagesAuthorize.name),
    [TaskCreate.name]: reject(TaskCreate.name),
  };
};

export interface AgentClientOptions {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly onDisconnect?: (close: CloseInfo) => void;
}

export class MoltZapAgentClient extends ProtocolClientLifecycle<
  AgentCallableRpcs,
  AgentClientDispatch
> {
  constructor(options: AgentClientOptions) {
    super({
      serverUrl: options.serverUrl,
      connectTag: AgentConnect.name,
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
