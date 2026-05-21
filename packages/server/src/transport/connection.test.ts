import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { agentId as makeAgentId } from "@moltzap/protocol/testing";
import type { AuthenticatedContext } from "../transport/context.js";
import type { AgentId } from "../app/types.js";
import { ConnectionManager, type MoltZapConnection } from "./connection.js";
import { unusedOriginator } from "./connection.test-utils.js";

/**
 * Pure-unit coverage for ConnectionManager.subscribeAgentsToConversation.
 */

const noopWrite: MoltZapConnection["write"] = () => Effect.void;
const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

const ALICE: AgentId = makeAgentId("00000000-0000-4000-8000-00000000a11c");
const BOB: AgentId = makeAgentId("00000000-0000-4000-8000-000000000b0b");
const CAROL: AgentId = makeAgentId("00000000-0000-4000-8000-0000000ca201");

function makeConn(id: string, agentId: AgentId | null): MoltZapConnection {
  const auth: AuthenticatedContext | null = agentId
    ? { agentId, agentStatus: "active", ownerUserId: null }
    : null;
  return {
    id,
    write: noopWrite,
    shutdown: noopShutdown,
    auth,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    originator: unusedOriginator(),
  };
}

describe("ConnectionManager.subscribeAgentsToConversation matching", () => {
  it("subscribes every matching connection to the conversation", () => {
    const manager = new ConnectionManager();
    const a1 = makeConn("c-alice-1", ALICE);
    const a2 = makeConn("c-alice-2", ALICE);
    const b1 = makeConn("c-bob-1", BOB);
    const c1 = makeConn("c-carol-1", CAROL);
    manager.add(a1);
    manager.add(a2);
    manager.add(b1);
    manager.add(c1);

    const subscribed = manager.subscribeAgentsToConversation(
      [ALICE, BOB],
      "conv-1",
    );

    expect(new Set(subscribed)).toEqual(
      new Set(["c-alice-1", "c-alice-2", "c-bob-1"]),
    );
    expect(a1.conversationIds.has("conv-1")).toBe(true);
    expect(a2.conversationIds.has("conv-1")).toBe(true);
    expect(b1.conversationIds.has("conv-1")).toBe(true);
    expect(c1.conversationIds.has("conv-1")).toBe(false);
  });

  it("skips connections that have not authenticated", () => {
    const manager = new ConnectionManager();
    const authed = makeConn("c-authed", ALICE);
    const unauthed = makeConn("c-unauthed", null);
    manager.add(authed);
    manager.add(unauthed);

    const subscribed = manager.subscribeAgentsToConversation([ALICE], "conv-1");

    expect(subscribed).toEqual(["c-authed"]);
    expect(unauthed.conversationIds.has("conv-1")).toBe(false);
  });
});

describe("ConnectionManager.subscribeAgentsToConversation no-op cases", () => {
  it("is idempotent — repeated calls do not double-subscribe", () => {
    const manager = new ConnectionManager();
    const conn = makeConn("c-1", ALICE);
    manager.add(conn);

    manager.subscribeAgentsToConversation([ALICE], "conv-1");
    manager.subscribeAgentsToConversation([ALICE], "conv-1");

    expect(conn.conversationIds.size).toBe(1);
    expect(conn.conversationIds.has("conv-1")).toBe(true);
  });

  it("returns empty when no connections match", () => {
    const manager = new ConnectionManager();
    manager.add(makeConn("c-1", ALICE));

    const subscribed = manager.subscribeAgentsToConversation(
      [BOB, CAROL],
      "conv-1",
    );

    expect(subscribed).toEqual([]);
  });

  it("handles an empty agentIds list", () => {
    const manager = new ConnectionManager();
    const conn = makeConn("c-1", ALICE);
    manager.add(conn);

    const subscribed = manager.subscribeAgentsToConversation([], "conv-1");

    expect(subscribed).toEqual([]);
    expect(conn.conversationIds.has("conv-1")).toBe(false);
  });
});
