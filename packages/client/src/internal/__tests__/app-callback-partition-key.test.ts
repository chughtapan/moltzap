import { describe, expect, it } from "vitest";
import { AppsOnBeforeDispatch } from "@moltzap/protocol";
import {
  describePartitionKey,
  extractPartitionKey,
  LIFECYCLE_CONVERSATION_SENTINEL,
} from "../app-callback-partition-key.js";
import {
  beforeDispatch,
  beforeMessageDelivery,
  CONV_X,
  CONV_Y,
  lifecycleRequests,
  SESSION_A,
  SESSION_B,
} from "./app-callback-test-requests.js";

describe("extractPartitionKey", () => {
  it("uses session, routed conversation, and descriptor method", () => {
    const key = extractPartitionKey(beforeDispatch("rpc-1"));
    const parts = describePartitionKey(key);

    expect(parts).toEqual({
      sessionId: SESSION_A,
      conversationId: CONV_X,
      definition: AppsOnBeforeDispatch,
    });
  });

  it("keeps app-callback methods in separate partitions for the same session and conversation", () => {
    const a = extractPartitionKey(beforeDispatch("rpc-1"));
    const b = extractPartitionKey(beforeMessageDelivery("rpc-2"));

    expect(a).not.toBe(b);
  });

  it("uses the lifecycle sentinel for lifecycle methods", () => {
    for (const { definition, request } of lifecycleRequests) {
      const parts = describePartitionKey(extractPartitionKey(request("rpc-3")));

      expect(parts.sessionId).toBe(SESSION_A);
      expect(parts.conversationId).toBe(LIFECYCLE_CONVERSATION_SENTINEL);
      expect(parts.definition).toBe(definition);
    }
  });

  it("separates sessions and conversations", () => {
    expect(extractPartitionKey(beforeDispatch("rpc-1", SESSION_A))).not.toBe(
      extractPartitionKey(beforeDispatch("rpc-2", SESSION_B)),
    );
    expect(
      extractPartitionKey(beforeDispatch("rpc-3", SESSION_A, CONV_X)),
    ).not.toBe(extractPartitionKey(beforeDispatch("rpc-4", SESSION_A, CONV_Y)));
  });
});
