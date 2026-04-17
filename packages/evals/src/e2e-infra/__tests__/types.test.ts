import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
  AgentResponseTimeoutError,
  ContainerError,
  type DockerError,
  DockerHealthTimeoutError,
  DockerImageError,
  DockerStartError,
  DockerStopError,
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

it.effect("DockerImageError tags carry the image name", () =>
  Effect.gen(function* () {
    const err = new DockerImageError({
      imageName: "moltzap-eval-agent:local",
      message: "inspect failed",
    });
    expect(err._tag).toBe("DockerImageError");
    expect(err.imageName).toBe("moltzap-eval-agent:local");
  }),
);

it.effect("DockerStartError tags carry the container name", () =>
  Effect.gen(function* () {
    const err = new DockerStartError({
      containerName: "eval-agent-0",
      message: "port conflict",
    });
    expect(err._tag).toBe("DockerStartError");
    expect(err.containerName).toBe("eval-agent-0");
  }),
);

it.effect("DockerHealthTimeoutError records the configured timeout", () =>
  Effect.gen(function* () {
    const err = new DockerHealthTimeoutError({
      containerName: "eval-agent-0",
      timeoutMs: 180_000,
      message: "gateway never came up",
    });
    expect(err._tag).toBe("DockerHealthTimeoutError");
    expect(err.timeoutMs).toBe(180_000);
  }),
);

it.effect("DockerStopError tags carry the container name", () =>
  Effect.gen(function* () {
    const err = new DockerStopError({
      containerName: "eval-agent-0",
      message: "docker rm failed",
    });
    expect(err._tag).toBe("DockerStopError");
  }),
);

it.effect("DockerError union is exhaustively discriminated by _tag", () =>
  Effect.gen(function* () {
    const errs: DockerError[] = [
      new DockerImageError({ imageName: "img", message: "m" }),
      new DockerStartError({ containerName: "c", message: "m" }),
      new DockerHealthTimeoutError({
        containerName: "c",
        timeoutMs: 1,
        message: "m",
      }),
      new DockerStopError({ containerName: "c", message: "m" }),
    ];

    // Exhaustiveness check: `absurd` only accepts `never`, so any new variant
    // added to the union must be handled here or typecheck will fail.
    const absurd = (x: never): never => {
      throw new Error(`unhandled DockerError variant: ${JSON.stringify(x)}`);
    };
    for (const err of errs) {
      switch (err._tag) {
        case "DockerImageError":
        case "DockerStartError":
        case "DockerHealthTimeoutError":
        case "DockerStopError":
          continue;
        default:
          absurd(err);
      }
    }
    expect(errs).toHaveLength(4);
  }),
);
