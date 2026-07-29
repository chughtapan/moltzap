import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { DEFAULT_APP_ID, taskRequest } from "@moltzap/protocol/task";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("connect() returns HelloOk with agentId", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent("svc-agent");
    const service = yield* H.connectService(reg.apiKey, reg.agentId);

    expect(service.ownAgentId).toBe(reg.agentId);
    expect(service.connected).toBe(true);

    service.close();
    yield* reg.client.close();
  }));

it("agent/conversation/list returns existing conversations after connect", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("agent-a");
    const regB = yield* H.registerAgent("agent-b");

    // Connect agent-a and create a conversation before agent-b connects as service
    yield* regA.client.connect();
    const conv = yield* regA.client.call(taskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [regB.agentId],
      initialConversation: { participants: [regB.agentId] },
    });

    // The handshake carries no task-layer state. Existing conversations are
    // fetched explicitly via `agent/conversation/list`.
    const service = yield* H.connectService(regB.apiKey, regB.agentId);
    expect(service.getConversation(conv.conversation!.id)).toBeUndefined();

    const list = yield* service.call(H.ConversationList.name, {});
    const found = list.items.find(
      (c) => c.conversation.id === conv.conversation!.id,
    );
    expect(found).toBeDefined();

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

it("on('message') fires for incoming message from another agent", () =>
  Effect.gen(function* () {
    const regSender = yield* H.registerAgent("sender");
    const regReceiver = yield* H.registerAgent("receiver");

    yield* regSender.client.connect();
    const service = yield* H.connectService(
      regReceiver.apiKey,
      regReceiver.agentId,
    );

    const conv = yield* regSender.client.call(taskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [regReceiver.agentId],
      initialConversation: { participants: [regReceiver.agentId] },
    });

    const received: unknown[] = [];
    service.on("message", (msg) => received.push(msg));

    yield* H.sendAndSettle(
      regSender.client,
      conv.task.id,
      conv.conversation!.id,
      H.HELLO_RECEIVER,
    );

    expect(received.length).toBe(1);
    const event = received[0] as {
      taskId: string;
      message: { parts: Array<{ text: string }> };
    };
    expect(event.taskId).toBe(conv.task.id);
    expect(event.message.parts[0]!.text).toBe(H.HELLO_RECEIVER);

    service.close();
    yield* regSender.client.close();
    yield* regReceiver.client.close();
  }));
