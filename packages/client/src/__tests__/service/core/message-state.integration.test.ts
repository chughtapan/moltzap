import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("on('message') skips own agent's messages", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("self-sender");
    const regB = yield* H.registerAgent("other");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const conv = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });

    const received: unknown[] = [];
    service.on("message", (msg) => received.push(msg));

    // Send from the service (own agent) — should NOT fire on("message")
    yield* service.send(conv.conversation.id, "Self message");
    yield* Effect.sleep(`${H.MESSAGE_SETTLE_MS} millis`);

    expect(received.length).toBe(0);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

it("getHistory() stores received messages", () =>
  Effect.gen(function* () {
    const regSender = yield* H.registerAgent("hist-sender");
    const regReceiver = yield* H.registerAgent("hist-receiver");

    yield* regSender.client.connect();
    const service = yield* H.connectService(regReceiver.apiKey);

    const conv = yield* regSender.client.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regReceiver.agentId }],
    });

    yield* H.sendAndSettle(regSender.client, conv.conversation.id, "msg 1");
    yield* H.sendAndSettle(regSender.client, conv.conversation.id, "msg 2");

    const history = service.getHistory(conv.conversation.id);
    expect(history.length).toBe(2);

    service.close();
    yield* regSender.client.close();
    yield* regReceiver.client.close();
  }));

it("resolveAgentName() returns and caches name", () =>
  Effect.gen(function* () {
    const reg = yield* H.registerAgent(H.SERVICE_NAME_TEST);
    const service = yield* H.connectService(reg.apiKey);

    // Before resolution, getAgentName returns undefined
    expect(service.getAgentName(reg.agentId)).toBeUndefined();

    const name = yield* service.resolveAgentName(reg.agentId);
    expect(name).toBe(H.SERVICE_NAME_TEST);

    // After resolution, getAgentName returns cached value
    expect(service.getAgentName(reg.agentId)).toBe(H.SERVICE_NAME_TEST);

    service.close();
    yield* reg.client.close();
  }));
