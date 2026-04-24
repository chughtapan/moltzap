/**
 * Unit tests for `moltzap messages list` handler. Spec test-coverage floor:
 * one success + one RPC-failure path.
 */
import { describe, it } from "vitest";

describe("messages list", () => {
  it.todo("calls messages/list with { conversationId, limit? }");
  it.todo("emits one message per line on success");
  it.todo("exits non-zero on TransportRpcError");
});
