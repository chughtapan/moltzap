import { assert, it } from "@effect/vitest";
import type { SimulatorDefinitionId } from "@moltzap/simulator";
import type { Image } from "@moltzap/simulator/agents";
import { decodeConditionId, decodeEvaluationCaseId } from "./model.js";
import {
  evaluationControllerModule,
  type SubmitEvaluationCellInput,
} from "./submission.js";

const PEER_IMAGE =
  "registry.example/moltzap-support@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" satisfies Image;
const NANOCLAW_IMAGE =
  "registry.example/nanoclaw-application@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" satisfies Image;
const DEFINITION_ID = "moltzap.eval-006/v4" satisfies SimulatorDefinitionId;

function input(
  condition: "openclaw/v2" | "nanoclaw/v2",
): SubmitEvaluationCellInput {
  return {
    workspaceRoot: "/workspace/moltzap",
    profile: "local",
    caseId: decodeEvaluationCaseId("EVAL-006"),
    definitionId: DEFINITION_ID,
    attemptId: "eval-006-nanoclaw-1",
    condition: {
      id: decodeConditionId(condition),
      modelId: condition === "openclaw/v2" ? "openai/gpt-5" : "claude/test",
    },
    peerApplicationImage: PEER_IMAGE,
    nanoclawApplicationImage: NANOCLAW_IMAGE,
    runtimeStartupTimeoutMillis: 300_000,
    peerObservationTimeoutMillis: 300_000,
    caseTimeoutMillis: 1_200_000,
  };
}

it("binds distinct peer and NanoClaw images into one NanoClaw cell module", () => {
  const source = evaluationControllerModule(input("nanoclaw/v2"));

  assert.include(source, `applicationImage: ${JSON.stringify(NANOCLAW_IMAGE)}`);
  assert.include(source, `peerApplicationImage: ${JSON.stringify(PEER_IMAGE)}`);
  assert.include(
    source,
    `definition.definitionId !== ${JSON.stringify(DEFINITION_ID)}`,
  );
  assert.include(
    source,
    'from "/opt/moltzap/node_modules/@moltzap/evals/dist/execution.js"',
  );
  assert.notInclude(source, `applicationImage: ${JSON.stringify(PEER_IMAGE)}`);
});

it("does not inject the unused NanoClaw application image into an OpenClaw cell", () => {
  const source = evaluationControllerModule(input("openclaw/v2"));

  assert.include(source, "openClawEvaluationCondition({ runtime:");
  assert.include(source, `peerApplicationImage: ${JSON.stringify(PEER_IMAGE)}`);
  assert.notInclude(source, NANOCLAW_IMAGE);
});
