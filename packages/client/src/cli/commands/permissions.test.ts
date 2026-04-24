/**
 * Unit tests for `moltzap permissions <subcommand>` handlers. Spec
 * test-coverage floor: one success + one RPC-failure per handler.
 */
import { describe, it } from "vitest";

describe("permissions grant", () => {
  it.todo(
    "calls permissions/grant with { sessionId, agentId, resource, access[] }",
  );
  it.todo("repeated --access values become an array on the wire");
  it.todo("exits non-zero on TransportRpcError");
});

describe("permissions list", () => {
  it.todo("calls permissions/list with optional appId filter");
  it.todo("prints one grant per line in the default format");
  it.todo("exits non-zero on TransportRpcError");
});

describe("permissions revoke", () => {
  it.todo("calls permissions/revoke with { appId, resource }");
  it.todo("exits non-zero on TransportRpcError");
});
