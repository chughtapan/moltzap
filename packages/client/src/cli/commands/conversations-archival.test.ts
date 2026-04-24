/**
 * Unit tests for `moltzap conversations {get,archive,unarchive}` handlers.
 * Spec test-coverage floor: one success + one RPC-failure per handler.
 */
import { describe, it } from "vitest";

describe("conversations get", () => {
  it.todo(
    "calls conversations/get and prints { conversation, participants } as JSON",
  );
  it.todo("exits non-zero on TransportRpcError");
});

describe("conversations archive", () => {
  it.todo("calls conversations/archive with the supplied id");
  it.todo("exits non-zero on TransportRpcError");
});

describe("conversations unarchive", () => {
  it.todo("calls conversations/unarchive with the supplied id");
  it.todo("exits non-zero on TransportRpcError");
});
