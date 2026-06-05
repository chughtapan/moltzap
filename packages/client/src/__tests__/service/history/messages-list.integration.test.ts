import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("messages/list returns both own and other agent messages", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("hist-a");
    const regB = yield* H.registerAgent("hist-b");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    // Create DM between A and B
    const conv = yield* H.createDm(service, regB.agentId);

    // A sends a message
    yield* service.send(conv.task.id, conv.conversation!.id, "Hello from A");
    yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);

    // B sends a message
    yield* H.sendAndSettle(
      regB.client,
      conv.task.id,
      conv.conversation!.id,
      "Hello from B",
    );

    // A sends another message
    yield* service.send(
      conv.task.id,
      conv.conversation!.id,
      "Follow up from A",
    );
    yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);

    // Fetch history via RPC (same as CLI moltzap history would do)
    const result = yield* service.call(H.MessagesList.name, {
      taskId: conv.task.id,
      conversationId: conv.conversation!.id,
      limit: 10,
    });

    // Should contain messages from BOTH agents
    expect(result.messages.length).toBeGreaterThanOrEqual(3);

    const senderIds = result.messages.map((m) => m.senderId);
    expect(senderIds).toContain(regA.agentId); // own messages
    expect(senderIds).toContain(regB.agentId); // other's messages

    // Verify own messages are identifiable via ownAgentId
    const ownMessages = result.messages.filter(
      (m) => m.senderId === service.ownAgentId,
    );
    expect(ownMessages.length).toBeGreaterThanOrEqual(2);

    const otherMessages = result.messages.filter(
      (m) => m.senderId === regB.agentId,
    );
    expect(otherMessages.length).toBeGreaterThanOrEqual(1);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

it("group conversation history shows all participants", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("grp-a");
    const regB = yield* H.registerAgent("grp-b");
    const regC = yield* H.registerAgent("grp-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    // Create group
    const conv = yield* service.call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [regB.agentId, regC.agentId],
      initialConversation: {
        name: "Test Group",
        participants: [regB.agentId, regC.agentId],
      },
    });
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    // Each agent sends a message
    yield* service.send(taskId, conversationId, "Agent A here");
    yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);
    yield* H.sendAndSettle(regB.client, taskId, conversationId, "Agent B here");
    yield* H.sendAndSettle(regC.client, taskId, conversationId, "Agent C here");

    // Fetch history
    const result = yield* service.call(H.MessagesList.name, {
      taskId,
      conversationId,
      limit: 10,
    });

    // All 3 agents should appear
    const senderIds = new Set(result.messages.map((m) => m.senderId));
    expect(senderIds.size).toBe(H.HISTORY_PARTICIPANT_COUNT);
    expect(senderIds).toContain(regA.agentId);
    expect(senderIds).toContain(regB.agentId);
    expect(senderIds).toContain(regC.agentId);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));
