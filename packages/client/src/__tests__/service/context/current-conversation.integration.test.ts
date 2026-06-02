import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("excludes current conversation's messages", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("excl-a");
    const regB = yield* H.registerAgent("excl-b");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    const conv = yield* H.createDm(service, regB.agentId);

    yield* H.sendAndSettle(
      regB.client,
      conv.task.id,
      conv.conversation!.id,
      "Same conv msg",
    );

    // getContext for the same conversation — should NOT include its own messages
    const ctx = service.getContext(conv.conversation!.id);
    expect(ctx).toBeNull();

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

it("shows resolved agent name, not UUID", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("name-res-a");
    const regB = yield* H.registerAgent("name-res-b");
    const regC = yield* H.registerAgent("name-res-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    yield* service.resolveAgentName(regC.agentId);

    const convB = yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      convC.conversation!.id,
      "Named msg",
    );

    const ctx = service.getContext(convB.conversation!.id)!;
    expect(ctx).toContain(H.RESOLVED_AGENT_CONTEXT_NAME);
    expect(ctx).not.toContain(regC.agentId);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

it("new message between calls produces new context", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("new-a");
    const regB = yield* H.registerAgent("new-b");
    const regC = yield* H.registerAgent("new-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    const convB = yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      convC.conversation!.id,
      H.FIRST_MESSAGE,
    );
    const first = service.getContext(convB.conversation!.id);
    expect(first).toContain(H.FIRST_MESSAGE);

    // Marker advanced — second call returns null
    expect(service.getContext(convB.conversation!.id)).toBeNull();

    // New message arrives
    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      convC.conversation!.id,
      H.SECOND_MESSAGE,
    );
    const third = service.getContext(convB.conversation!.id);
    expect(third).not.toBeNull();
    expect(third).toContain(H.SECOND_MESSAGE);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));
