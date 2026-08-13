import type { SimulatorDefinitionId } from "@moltzap/simulator";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, effect, it } from "@effect/vitest";
import { image } from "@moltzap/simulator/agents";
import { Effect, Schema } from "effect";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeEvaluationCaseId,
  decodeEvaluationConditionId,
  type EvaluationConditionName,
} from "./model.js";
import {
  decodeSubmissionOutput,
  evaluationControllerModule,
  type SimulatorProfile,
  simulatorProfileEntrypoint,
  submissionDiagnostic,
  type SubmitEvaluationCellInput,
} from "./submission.js";

const decodeImage = Schema.decodeSync(image);
const NANOCLAW_IMAGE = decodeImage(
  "registry.example/nanoclaw-application@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const DEFINITION_ID = "moltzap.eval-019/v3" satisfies SimulatorDefinitionId;

function input(condition: EvaluationConditionName): SubmitEvaluationCellInput {
  return {
    workspaceRoot: "/workspace/moltzap",
    profile: "local",
    caseId: decodeEvaluationCaseId("EVAL-019"),
    definitionId: DEFINITION_ID,
    attemptId: "eval-019-nanoclaw-1",
    condition: {
      id: decodeEvaluationConditionId(condition),
      modelId: condition === "openclaw/v2" ? "openai/gpt-5" : "claude/test",
    },
    nanoclawApplicationImage: NANOCLAW_IMAGE,
    runtimeStartupTimeoutMillis: 300_000,
    caseTimeoutMillis: 1_200_000,
  };
}

it("binds the NanoClaw image into one NanoClaw cell module", () => {
  const source = evaluationControllerModule(input("nanoclaw/v2"));

  assert.include(source, `applicationImage: ${JSON.stringify(NANOCLAW_IMAGE)}`);
  assert.include(
    source,
    `definition.definitionId !== ${JSON.stringify(DEFINITION_ID)}`,
  );
  assert.include(
    source,
    'from "/opt/moltzap/node_modules/@moltzap/evals/dist/execution.js"',
  );
});

it("does not inject the unused NanoClaw application image into an OpenClaw cell", () => {
  const source = evaluationControllerModule(input("openclaw/v2"));

  assert.include(source, "openClawEvaluationCondition({ runtime:");
  assert.notInclude(source, NANOCLAW_IMAGE);
});

effect.each(["local", "gke"] as const)(
  "spawns the %s profile executable the simulator package actually ships",
  (profile: SimulatorProfile) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const simulatorRoot = fileURLToPath(
        new URL("../../simulator", import.meta.url),
      );
      const entrypoint = join(
        simulatorRoot,
        ...simulatorProfileEntrypoint(profile),
      );

      // The submitter spawns this file by path, so no import checks the
      // spelling. Pin it against the source module the build compiles it from,
      // and against the same path in the simulator's own scripts, so a rename
      // cannot move one and leave the other naming a file that never appears.
      const source = entrypoint
        .replace(`${sep}dist${sep}`, `${sep}src${sep}`)
        .replace(/\.js$/u, ".ts");
      assert.isTrue(
        yield* fileSystem.exists(source),
        `no source module compiles to ${entrypoint}`,
      );

      const scripts = yield* fileSystem.readFileString(
        join(simulatorRoot, "package.json"),
      );
      assert.include(scripts, simulatorProfileEntrypoint(profile).join("/"));
    }).pipe(Effect.provide(NodeContext.layer)),
);

// Exactly what the simulator's submitter prints for a cluster-lost cell, so a
// consumer that stops accepting the real line fails here first.
function submitterLine(diagnostic?: string): string {
  return JSON.stringify({
    runId: "mz-0123456789abcdef0123456789abcdef",
    namespace: "mz-0123456789abcdef0123456789abcdef",
    result: {
      exitCode: 1,
      summary: {
        _tag: "ClusterLost",
        receipt: {
          _tag: "IncompleteLedgerReceipt",
          ledger: "eval-006-nanoclaw-1",
        },
      },
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  });
}

const CARRIED_DIAGNOSTIC = "controller Job failed\nreason";
const OVERSIZED_DIAGNOSTIC_LENGTH = 32_768;

effect.each([undefined, CARRIED_DIAGNOSTIC])(
  "decodes a submitter result whose diagnostic is %s",
  (diagnostic?: string) =>
    Effect.gen(function* () {
      const decoded = yield* decodeSubmissionOutput(submitterLine(diagnostic));

      assert.strictEqual(submissionDiagnostic(decoded), diagnostic);
    }),
);

// The rest of that line is the run's only receipt. Refusing an over-long
// diagnostic would discard it, turning a cell that failed with evidence into a
// cell with no attempt at all.
it("keeps the receipt when a submitter diagnostic is over-long", () =>
  Effect.gen(function* () {
    const oversized = "x".repeat(OVERSIZED_DIAGNOSTIC_LENGTH);
    const decoded = yield* decodeSubmissionOutput(submitterLine(oversized));

    assert.isTrue("receipt" in decoded.result.summary);
    assert.strictEqual(submissionDiagnostic(decoded), oversized);
  }));
