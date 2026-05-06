import { describe, expect, it } from "vitest";
import { TaskAuthorizeDispatch } from "@moltzap/protocol";
import {
  describePartitionKey,
  extractPartitionKey,
} from "../app-callback-partition-key.js";
import {
  authorizeDispatch,
  CONV_X,
  CONV_Y,
  SESSION_A,
  SESSION_B,
} from "./app-callback-test-requests.js";

describe("extractPartitionKey", () => {
  it("uses session, routed conversation, and descriptor method", () => {
    const key = extractPartitionKey(authorizeDispatch("rpc-1"));
    const parts = describePartitionKey(key);

    expect(parts).toEqual({
      taskId: SESSION_A,
      conversationId: CONV_X,
      definition: TaskAuthorizeDispatch,
    });
  });

  it("separates sessions and conversations", () => {
    expect(extractPartitionKey(authorizeDispatch("rpc-1", SESSION_A))).not.toBe(
      extractPartitionKey(authorizeDispatch("rpc-2", SESSION_B)),
    );
    expect(
      extractPartitionKey(authorizeDispatch("rpc-3", SESSION_A, CONV_X)),
    ).not.toBe(
      extractPartitionKey(authorizeDispatch("rpc-4", SESSION_A, CONV_Y)),
    );
  });
});
