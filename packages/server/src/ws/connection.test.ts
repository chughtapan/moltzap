import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { AuthenticatedContext } from "../rpc/context.js";
import type { AgentId } from "../app/types.js";
import { ConnectionManager, type MoltZapConnection } from "./connection.js";

/**
 * Pure-unit coverage for ConnectionManager.subscribeAgentsToConversation.
 *
 * The helper exists so downstream apps (e.g. moltzap-arena's Werewolf) can
 * create conversations via ConversationService.create and still reach the
 * same state the `conversations/create` RPC handler reaches — without
 * duplicating the subscription loop in every caller.
 */

const noopWrite: MoltZapConnection["write"] = () => Effect.void;
const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

function makeConn(id: string, agentId: string | null): MoltZapConnection {
  const auth: AuthenticatedContext | null = agentId
    ? {
        agentId: agentId as AgentId,
        agentStatus: "active",
        ownerUserId: null,
      }
    : null;
  return {
    id,
    write: noopWrite,
    shutdown: noopShutdown,
    auth,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
  };
}

describe("ConnectionManager.subscribeAgentsToConversation", () => {
  it("subscribes every matching connection to the conversation", () => {
    const manager = new ConnectionManager();
    const a1 = makeConn("c-alice-1", "alice");
    const a2 = makeConn("c-alice-2", "alice");
    const b1 = makeConn("c-bob-1", "bob");
    const c1 = makeConn("c-carol-1", "carol");
    manager.add(a1);
    manager.add(a2);
    manager.add(b1);
    manager.add(c1);

    const subscribed = manager.subscribeAgentsToConversation(
      ["alice", "bob"],
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
    const authed = makeConn("c-authed", "alice");
    const unauthed = makeConn("c-unauthed", null);
    manager.add(authed);
    manager.add(unauthed);

    const subscribed = manager.subscribeAgentsToConversation(
      ["alice"],
      "conv-1",
    );

    expect(subscribed).toEqual(["c-authed"]);
    expect(unauthed.conversationIds.has("conv-1")).toBe(false);
  });

  it("is idempotent — repeated calls do not double-subscribe", () => {
    const manager = new ConnectionManager();
    const conn = makeConn("c-1", "alice");
    manager.add(conn);

    manager.subscribeAgentsToConversation(["alice"], "conv-1");
    manager.subscribeAgentsToConversation(["alice"], "conv-1");

    expect(conn.conversationIds.size).toBe(1);
    expect(conn.conversationIds.has("conv-1")).toBe(true);
  });

  it("returns empty when no connections match", () => {
    const manager = new ConnectionManager();
    manager.add(makeConn("c-1", "alice"));

    const subscribed = manager.subscribeAgentsToConversation(
      ["bob", "carol"],
      "conv-1",
    );

    expect(subscribed).toEqual([]);
  });

  it("handles an empty agentIds list", () => {
    const manager = new ConnectionManager();
    const conn = makeConn("c-1", "alice");
    manager.add(conn);

    const subscribed = manager.subscribeAgentsToConversation([], "conv-1");

    expect(subscribed).toEqual([]);
    expect(conn.conversationIds.has("conv-1")).toBe(false);
  });
});
