/**
 * Unit tests for the v2 subcommand handlers added to conversations.ts
 * (sbd#185). Keeps v1 tests untouched — lives in a sibling file so the
 * existing conversations test module is not edited at architect stage.
 *
 * Spec test-coverage floor: one success + one RPC-failure per handler.
 */
import { describe, it } from "vitest";

describe("conversations get (v2)", () => {
  it.todo(
    "calls conversations/get and prints { conversation, participants } as JSON",
  );
  it.todo("exits non-zero on TransportRpcError");
});

describe("conversations archive (v2)", () => {
  it.todo("calls conversations/archive with the supplied id");
  it.todo("exits non-zero on TransportRpcError");
});

describe("conversations unarchive (v2)", () => {
  it.todo("calls conversations/unarchive with the supplied id");
  it.todo("exits non-zero on TransportRpcError");
});
