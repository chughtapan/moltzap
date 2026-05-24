import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("returns null with only one conversation active", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("ctx-a");
    const regB = yield* H.registerAgent("ctx-b");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const conv = yield* H.createDm(service, regB.agentId);

    yield* H.sendAndSettle(
      regB.client,
      conv.task.id,
      conv.conversation!.id,
      "Hello",
    );

    // Only one conversation — no "other" conversations to report
    const ctx = service.getContext(conv.conversation!.id);
    expect(ctx).toBeNull();

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

it("returns null when other conversations have no messages", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("null-a");
    const regB = yield* H.registerAgent("null-b");
    const regC = yield* H.registerAgent("null-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const convB = yield* H.createDm(service, regB.agentId);

    // Create conv with C but don't send any messages in it
    yield* H.createDm(service, regC.agentId);

    yield* H.sendAndSettle(
      regB.client,
      convB.task.id,
      convB.conversation!.id,
      "msg in B",
    );

    const ctx = service.getContext(convB.conversation!.id);
    // Conv C has no messages → no context
    expect(ctx).toBeNull();

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

it("returns system-reminder with new messages from other conversation", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("xc-a");
    const regB = yield* H.registerAgent("xc-b");
    const regC = yield* H.registerAgent("xc-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const convB = yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    // Send message in conv C
    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      convC.conversation!.id,
      H.HELLO_FROM_C,
    );

    // Get context from conv B's perspective — should see conv C's message
    const ctx = service.getContext(convB.conversation!.id);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain(H.SYSTEM_REMINDER_OPEN);
    expect(ctx).toContain(H.SYSTEM_REMINDER_CLOSE);
    expect(ctx).toContain(H.HELLO_FROM_C);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));
