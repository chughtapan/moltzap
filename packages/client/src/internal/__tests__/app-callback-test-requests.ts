import {
  TaskAuthorizeDispatch,
  type JsonRpcId,
  type ParamsOf,
} from "@moltzap/protocol";
import {
  agentId,
  conversationId,
  messageId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";
import { type PartitionableRequest } from "../app-callback-partition-key.js";

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

/**
 * Phase 9b consumer-migration (sub-issue #460): the client-test fixtures
 * for the deleted appCallback verbs (`apps/onBeforeMessageDelivery`,
 * `apps/onSessionActive`, `apps/onClose`) retired. Only
 * `task/authorizeDispatch` (renamed from `apps/onBeforeDispatch`) remains;
 * its fixture keeps the same shape — the verdict union, the recipient
 * envelope, the params layout — because werewolf's dispatch state
 * machine consumes it unchanged.
 */
export function authorizeDispatchParams(
  taskId = SESSION_A,
  conv = CONV_X,
): ParamsOf<typeof TaskAuthorizeDispatch> {
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

export function authorizeDispatch(
  id: string,
  taskId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest {
  const params = authorizeDispatchParams(taskId, conv);
  return {
    id: id as JsonRpcId,
    definition: TaskAuthorizeDispatch,
    params,
    partition: { taskId, conversationId: conv },
  };
}
