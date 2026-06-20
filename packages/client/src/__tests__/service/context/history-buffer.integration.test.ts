import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("buffer stores all messages without eviction", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("ring-a");
    const regB = yield* H.registerAgent("ring-b");
    const regC = yield* H.registerAgent("ring-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    for (let i = 0; i < H.HISTORY_MESSAGE_COUNT; i++) {
      yield* regC.client.call(H.MessagesSend.name, {
        taskId: convC.task.id,
        conversationId: convC.conversation!.id,
        parts: [{ type: "text", text: `msg-${i}` }],
      });
    }
    yield* Effect.sleep(`${H.HISTORY_SETTLE_MS} millis`);

    const history = service.getHistory(convC.conversation!.id);
    expect(history.length).toBe(H.HISTORY_MESSAGE_COUNT);

    const texts = history.map(H.textContent);
    expect(texts).toContain(H.HISTORY_FIRST_BUFFER_MESSAGE);
    expect(texts).toContain(H.HISTORY_LAST_BUFFER_MESSAGE);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));
