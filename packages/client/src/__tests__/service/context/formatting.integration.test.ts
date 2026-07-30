import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("format matches @name (Xm ago): (N new) pattern", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("fmt-a");
    const regB = yield* H.registerAgent("fmt-b");
    const regC = yield* H.registerAgent("fmt-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    // Resolve C's name so it appears in context
    yield* service.resolveAgentName(regC.agentId);

    const convB = yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      /* Safe because the test fixture establishes this asserted shape. */ convC
        .conversation!.id,
      "Test message",
    );

    const ctx =
      /* Safe because the test fixture establishes this asserted shape. */ service.getContext(
        /* Safe because the test fixture establishes this asserted shape. */ convB
          .conversation!.id,
      )!;
    expect(ctx).toMatch(/@fmt-c \(\d+m ago\): \(1 new\) "Test message"/);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

it("truncates long messages at 120 chars", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("trunc-a");
    const regB = yield* H.registerAgent("trunc-b");
    const regC = yield* H.registerAgent("trunc-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    const convB = yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    const longMsg = "A".repeat(H.LONG_MESSAGE_LENGTH);
    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      /* Safe because the test fixture establishes this asserted shape. */ convC
        .conversation!.id,
      longMsg,
    );

    const ctx =
      /* Safe because the test fixture establishes this asserted shape. */ service.getContext(
        /* Safe because the test fixture establishes this asserted shape. */ convB
          .conversation!.id,
      )!;
    // The preview should be truncated — full 500-char message should not appear
    expect(ctx).not.toContain("A".repeat(H.LONG_MESSAGE_LENGTH));
    expect(ctx.length).toBeLessThan(H.LONG_MESSAGE_LENGTH);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));

it("advances markers — second call returns null", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("mark-a");
    const regB = yield* H.registerAgent("mark-b");
    const regC = yield* H.registerAgent("mark-c");

    yield* regB.client.connect();
    yield* regC.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    const convB = yield* H.createDm(service, regB.agentId);
    const convC = yield* H.createDm(service, regC.agentId);

    yield* H.sendAndSettle(
      regC.client,
      convC.task.id,
      /* Safe because the test fixture establishes this asserted shape. */ convC
        .conversation!.id,
      "Once",
    );

    const first = service.getContext(
      /* Safe because the test fixture establishes this asserted shape. */ convB
        .conversation!.id,
    );
    expect(first).not.toBeNull();

    // Second call — no new messages since marker advanced
    const second = service.getContext(
      /* Safe because the test fixture establishes this asserted shape. */ convB
        .conversation!.id,
    );
    expect(second).toBeNull();

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
    yield* regC.client.close();
  }));
