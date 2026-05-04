import {
  agentId,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnSessionActive,
  conversationId,
  jsonRpcStringId,
  messageId,
  type Static,
} from "@moltzap/protocol";
import {
  LIFECYCLE_CONVERSATION_SENTINEL,
  type PartitionableRequest,
} from "../app-callback-partition-key.js";

export const SESSION_A = "11111111-1111-4111-8111-111111111111";
export const SESSION_B = "22222222-2222-4222-8222-222222222222";
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
  sessionId = SESSION_A,
  conv = CONV_X,
): Static<typeof AppsOnBeforeDispatch.paramsSchema> {
  return {
    sessionId,
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
  sessionId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest {
  const params = beforeDispatchParams(sessionId, conv);
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnBeforeDispatch,
    params,
    partition: { sessionId, conversationId: conv },
  };
}

export function beforeMessageDeliveryParams(
  sessionId = SESSION_A,
  conv = CONV_X,
): Static<typeof AppsOnBeforeMessageDelivery.paramsSchema> {
  return {
    sessionId,
    appId: "test-app",
    conversationId: conv,
    sender: { agentId: AGENT_A, ownerId: "owner-a" },
    message: { parts: [{ type: "text", text: "hello" }] },
  };
}

export function beforeMessageDelivery(
  id: string,
  sessionId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest {
  const params = beforeMessageDeliveryParams(sessionId, conv);
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnBeforeMessageDelivery,
    params,
    partition: { sessionId, conversationId: conv },
  };
}

export function onCloseParams(
  sessionId = SESSION_A,
): Static<typeof AppsOnClose.paramsSchema> {
  return {
    sessionId,
    appId: "test-app",
    conversations: { main: CONV_X },
    closedBy: { agentId: AGENT_A, ownerId: "owner-a" },
  };
}

export function onClose(
  id: string,
  sessionId = SESSION_A,
): PartitionableRequest {
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnClose,
    params: onCloseParams(sessionId),
    partition: {
      sessionId,
      conversationId: LIFECYCLE_CONVERSATION_SENTINEL,
    },
  };
}

export function onSessionActiveParams(
  sessionId = SESSION_A,
): Static<typeof AppsOnSessionActive.paramsSchema> {
  return {
    sessionId,
    appId: "test-app",
    conversations: { main: CONV_X },
    admittedAgentIds: [AGENT_A],
  };
}

export function onSessionActive(
  id: string,
  sessionId = SESSION_A,
): PartitionableRequest {
  return {
    id: jsonRpcStringId(id),
    definition: AppsOnSessionActive,
    params: onSessionActiveParams(sessionId),
    partition: {
      sessionId,
      conversationId: LIFECYCLE_CONVERSATION_SENTINEL,
    },
  };
}

export const lifecycleRequests = [
  {
    definition: AppsOnClose,
    request: (id: string, sessionId = SESSION_A) => onClose(id, sessionId),
  },
  {
    definition: AppsOnSessionActive,
    request: (id: string, sessionId = SESSION_A) =>
      onSessionActive(id, sessionId),
  },
] as const;
