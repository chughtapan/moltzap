import {
  agentId,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnSessionActive,
  conversationId,
  jsonRpcStringId,
  messageId,
  taskId as makeTaskId,
  type Static,
} from "@moltzap/protocol";
import {
  LIFECYCLE_CONVERSATION_SENTINEL,
  type PartitionableRequest,
} from "../app-callback-partition-key.js";

export const SESSION_A = makeTaskId("11111111-1111-4111-8111-111111111111");
export const SESSION_B = makeTaskId("22222222-2222-4222-8222-222222222222");
export const CONV_X = conversationId("33333333-3333-4333-8333-333333333333");
export const CONV_Y = conversationId("44444444-4444-4444-8444-444444444444");
export const CONV_Z = conversationId("77777777-7777-4777-8777-777777777777");
export const AGENT_A = agentId("55555555-5555-4555-8555-555555555555");
export const MESSAGE_A = messageId("66666666-6666-4666-8666-666666666666");
const UUID_SUFFIX_WIDTH = 12;

export const conversationIdForIndex = (index: number) =>
  conversationId(
    `33333333-3333-4333-8333-${index.toString().padStart(UUID_SUFFIX_WIDTH, "0")}`,
  );

export function beforeDispatchParams(
  taskId = SESSION_A,
  conv = CONV_X,
): Static<typeof AppsOnBeforeDispatch.paramsSchema> {
  return {
    taskId,
    appId: "test-app",
    conversationId: conv,
    recipient: { agentId: AGENT_A, ownerId: "owner-a" },
    message: {
      id: MESSAGE_A,
      senderAgentId: AGENT_A,
      parts: [{ type: "text", text: "hello" }],
    },
    attempt: 0,
  };
}

export function beforeDispatch(
  id: string,
  taskId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest {
  const params = beforeDispatchParams(taskId, conv);
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnBeforeDispatch,
    params,
    partition: { taskId, conversationId: conv },
  };
}

export function beforeMessageDeliveryParams(
  taskId = SESSION_A,
  conv = CONV_X,
): Static<typeof AppsOnBeforeMessageDelivery.paramsSchema> {
  return {
    taskId,
    appId: "test-app",
    conversationId: conv,
    sender: { agentId: AGENT_A, ownerId: "owner-a" },
    message: { parts: [{ type: "text", text: "hello" }] },
  };
}

export function beforeMessageDelivery(
  id: string,
  taskId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest {
  const params = beforeMessageDeliveryParams(taskId, conv);
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnBeforeMessageDelivery,
    params,
    partition: { taskId, conversationId: conv },
  };
}

export function onCloseParams(
  taskId = SESSION_A,
): Static<typeof AppsOnClose.paramsSchema> {
  return {
    taskId,
    appId: "test-app",
    conversations: { main: CONV_X },
    closedBy: { agentId: AGENT_A, ownerId: "owner-a" },
  };
}

export function onClose(id: string, taskId = SESSION_A): PartitionableRequest {
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnClose,
    params: onCloseParams(taskId),
    partition: {
      taskId,
      conversationId: LIFECYCLE_CONVERSATION_SENTINEL,
    },
  };
}

export function onSessionActiveParams(
  taskId = SESSION_A,
): Static<typeof AppsOnSessionActive.paramsSchema> {
  return {
    taskId,
    appId: "test-app",
    conversations: { main: CONV_X },
    admittedAgentIds: [AGENT_A],
  };
}

export function onSessionActive(
  id: string,
  taskId = SESSION_A,
): PartitionableRequest {
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnSessionActive,
    params: onSessionActiveParams(taskId),
    partition: {
      taskId,
      conversationId: LIFECYCLE_CONVERSATION_SENTINEL,
    },
  };
}

export const lifecycleRequests = [
  {
    definition: AppsOnClose,
    request: (id: string, taskId = SESSION_A) => onClose(id, taskId),
  },
  {
    definition: AppsOnSessionActive,
    request: (id: string, taskId = SESSION_A) => onSessionActive(id, taskId),
  },
] as const;
