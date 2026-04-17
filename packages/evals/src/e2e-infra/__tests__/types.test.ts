import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
  AgentResponseTimeoutError,
  ContainerError,
  JudgeError,
  ScenarioGenerationError,
} from "../types.js";

it.effect("JudgeError is tagged and carries fatality flag", () =>
  Effect.gen(function* () {
    const err = new JudgeError({ message: "boom", fatal: true });
    expect(err._tag).toBe("JudgeError");
    expect(err.fatal).toBe(true);

    const exit = yield* Effect.exit(Effect.fail(err));
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("JudgeError");
    } else {
      throw new Error("expected failure");
    }
  }),
);

it.effect("ContainerError captures phase and name", () =>
  Effect.gen(function* () {
    const err = new ContainerError({
      containerName: "eval-agent-0",
      phase: "start",
      message: "port conflict",
    });
    expect(err._tag).toBe("ContainerError");
    expect(err.phase).toBe("start");
  }),
);

it.effect("ScenarioGenerationError carries scenario id", () =>
  Effect.gen(function* () {
    const err = new ScenarioGenerationError({
      scenarioId: "EVAL-001",
      message: "timed out",
    });
    expect(err._tag).toBe("ScenarioGenerationError");
    expect(err.scenarioId).toBe("EVAL-001");
  }),
);

it.effect("AgentResponseTimeoutError carries timeout info", () =>
  Effect.gen(function* () {
    const err = new AgentResponseTimeoutError({
      conversationId: "conv-abc",
      timeoutMs: 30_000,
    });
    expect(err._tag).toBe("AgentResponseTimeoutError");
    expect(err.timeoutMs).toBe(30_000);
  }),
);
