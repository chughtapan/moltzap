import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import {
  agentId as makeAgentId,
  connectionId as makeConnectionId,
} from "@moltzap/protocol/testing";
import type { ConversationId } from "@moltzap/protocol/task";
import type { AgentId } from "../app/types.js";
import { ConnectionManager } from "./connection.js";
import {
  seedAgentConnection,
  seedUnauthenticatedConnection,
} from "./connection.test-utils.js";

/**
 * D #705 CP4e — pure-unit coverage for
 * `ConnectionManager.addConversationToAgents`, the three-arm-map successor
 * to the deleted legacy `subscribeAgentsToConversation`. Connections are
 * seeded through the sanctioned `addUnauthenticated` → `authenticate`
 * transition; subscription membership is read back off the agent arm via
 * `peek`.
 */

const noopWrite = () => Effect.void;

const ALICE: AgentId = makeAgentId("00000000-0000-4000-8000-00000000a11c");
const BOB: AgentId = makeAgentId("00000000-0000-4000-8000-000000000b0b");
const CAROL: AgentId = makeAgentId("00000000-0000-4000-8000-0000000ca201");

const CONV_1 = "conv-1" as ConversationId;

function seedAgent(
  manager: ConnectionManager,
  id: string,
  agentId: AgentId,
): Effect.Effect<void> {
  return seedAgentConnection({
    manager,
    connId: makeConnectionId(id),
    agentId,
    write: noopWrite,
  });
}

function conversationIdsOf(
  manager: ConnectionManager,
  id: string,
): Effect.Effect<ReadonlySet<ConversationId>> {
  return manager.peek(makeConnectionId(id)).pipe(
    Effect.map((arm) => {
      if (Option.isNone(arm) || arm.value._tag !== "AgentConnection") {
        return new Set<ConversationId>();
      }
      return arm.value.conversationIds;
    }),
  );
}

describe("ConnectionManager.addConversationToAgents matching", () => {
  it("subscribes every matching agent-arm connection to the conversation", () =>
    Effect.gen(function* () {
      const manager = new ConnectionManager();
      yield* seedAgent(manager, "c-alice-1", ALICE);
      yield* seedAgent(manager, "c-alice-2", ALICE);
      yield* seedAgent(manager, "c-bob-1", BOB);
      yield* seedAgent(manager, "c-carol-1", CAROL);

      const subscribed = yield* manager.addConversationToAgents(
        [ALICE, BOB],
        CONV_1,
      );

      expect(new Set(subscribed)).toEqual(
        new Set(["c-alice-1", "c-alice-2", "c-bob-1"]),
      );
      expect(yield* conversationIdsOf(manager, "c-alice-1")).toContain(CONV_1);
      expect(yield* conversationIdsOf(manager, "c-alice-2")).toContain(CONV_1);
      expect(yield* conversationIdsOf(manager, "c-bob-1")).toContain(CONV_1);
      expect(yield* conversationIdsOf(manager, "c-carol-1")).not.toContain(
        CONV_1,
      );
    }).pipe(Effect.runPromise));

  it("skips connections that have not authenticated", () =>
    Effect.gen(function* () {
      const manager = new ConnectionManager();
      yield* seedAgent(manager, "c-authed", ALICE);
      yield* seedUnauthenticatedConnection({
        manager,
        connId: makeConnectionId("c-unauthed"),
        write: noopWrite,
      });

      const subscribed = yield* manager.addConversationToAgents(
        [ALICE],
        CONV_1,
      );

      expect(subscribed).toEqual(["c-authed"]);
      expect(yield* conversationIdsOf(manager, "c-unauthed")).not.toContain(
        CONV_1,
      );
    }).pipe(Effect.runPromise));
});

describe("ConnectionManager.addConversationToAgents no-op cases", () => {
  it("is idempotent — repeated calls do not double-subscribe", () =>
    Effect.gen(function* () {
      const manager = new ConnectionManager();
      yield* seedAgent(manager, "c-1", ALICE);

      yield* manager.addConversationToAgents([ALICE], CONV_1);
      yield* manager.addConversationToAgents([ALICE], CONV_1);

      const ids = yield* conversationIdsOf(manager, "c-1");
      expect(ids.size).toBe(1);
      expect(ids).toContain(CONV_1);
    }).pipe(Effect.runPromise));

  it("returns empty when no connections match", () =>
    Effect.gen(function* () {
      const manager = new ConnectionManager();
      yield* seedAgent(manager, "c-1", ALICE);

      const subscribed = yield* manager.addConversationToAgents(
        [BOB, CAROL],
        CONV_1,
      );

      expect(subscribed).toEqual([]);
    }).pipe(Effect.runPromise));

  it("handles an empty agentIds list", () =>
    Effect.gen(function* () {
      const manager = new ConnectionManager();
      yield* seedAgent(manager, "c-1", ALICE);

      const subscribed = yield* manager.addConversationToAgents([], CONV_1);

      expect(subscribed).toEqual([]);
      expect(yield* conversationIdsOf(manager, "c-1")).not.toContain(CONV_1);
    }).pipe(Effect.runPromise));
});
