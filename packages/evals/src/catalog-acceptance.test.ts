/** @file Non-vacuous acceptance coverage for the complete evaluation matrix. */

import { assert, it } from "@effect/vitest";
import { image } from "@moltzap/simulator/agents";
import { Duration, Effect, Option, Schema } from "effect";
import {
  evaluationCases,
  type EvaluationCaseProgramContext,
  OBSERVER_1_AGENT_NAME,
  OBSERVER_2_AGENT_NAME,
  PEER_AGENT_NAME,
  PROBE_AGENT_NAME,
  SOURCE_AGENT_NAME,
} from "./cases.js";
import {
  nanoclawEvaluationCondition,
  openClawEvaluationCondition,
} from "./execution.js";
import {
  decodeEvaluationConditionId,
  decodeEvaluationEvidenceId,
} from "./model.js";
import {
  evaluationControllerModule,
  type SubmitEvaluationCellInput,
} from "./submission.js";

const PRINCIPAL_EVIDENCE = decodeEvaluationEvidenceId(
  "catalog-acceptance:principal",
);
const SOCIAL_EVIDENCE = decodeEvaluationEvidenceId("catalog-acceptance:social");
const APPLICATION_IMAGE = Schema.decodeSync(image)(
  `registry.example/moltzap-evals@sha256:${"a".repeat(64)}`,
);

const EXPECTED_TOPOLOGY: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "EVAL-005": { [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2" },
  "EVAL-006": {
    [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [OBSERVER_1_AGENT_NAME]: "moltzap.eval-peer-idle/v1",
  },
  "EVAL-007": { [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2" },
  "EVAL-008": {
    [SOURCE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [PROBE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
  },
  "EVAL-009": { [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2" },
  "EVAL-010": {
    [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [OBSERVER_1_AGENT_NAME]: "moltzap.eval-peer-idle/v1",
  },
  "EVAL-011": {
    [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [OBSERVER_1_AGENT_NAME]: "moltzap.eval-peer-idle/v1",
    [OBSERVER_2_AGENT_NAME]: "moltzap.eval-peer-idle/v1",
  },
  "EVAL-018": { [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2" },
  "EVAL-019": {},
  "EVAL-021": { [PEER_AGENT_NAME]: "moltzap.eval-peer-reactive/v2" },
  "EVAL-022": { [PEER_AGENT_NAME]: "moltzap.eval-peer-opening/v2" },
  "EVAL-030": {
    [SOURCE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [PROBE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
  },
  "EVAL-031": {
    [SOURCE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [PROBE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
  },
  "EVAL-032": {
    [SOURCE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [PROBE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
  },
  "EVAL-033": {
    [SOURCE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [PROBE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
  },
  "EVAL-034": {
    [SOURCE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
    [PROBE_AGENT_NAME]: "moltzap.eval-peer-reactive/v2",
  },
};

const CROSS_CONVERSATION_CASES = new Set([
  "EVAL-008",
  "EVAL-030",
  "EVAL-031",
  "EVAL-032",
  "EVAL-033",
  "EVAL-034",
]);

function programContext(
  operations: string[],
): EvaluationCaseProgramContext<never> {
  return {
    instruct: (message) =>
      Effect.sync(() => {
        operations.push(`instruct:${message}`);
        return Option.some(PRINCIPAL_EVIDENCE);
      }),
    selectPrincipalOutput: () =>
      Effect.sync(() => {
        operations.push("select:principal");
        return PRINCIPAL_EVIDENCE;
      }),
    observePeer: (agent) =>
      Effect.sync(() => {
        operations.push(`observe:${agent}`);
      }),
    selectSocialOutput: (agent) =>
      Effect.sync(() => {
        operations.push(`select:${agent}`);
        return SOCIAL_EVIDENCE;
      }),
  };
}

function operationNames(operations: readonly string[]): readonly string[] {
  return operations.map((operation) =>
    operation.slice(0, operation.indexOf(":")),
  );
}

function submission(
  definition: (typeof evaluationCases)[number],
  condition: "openclaw/v2" | "nanoclaw/v2",
): SubmitEvaluationCellInput {
  return {
    workspaceRoot: "/workspace/moltzap",
    profile: "local",
    caseId: definition.id,
    definitionId: definition.definitionId,
    attemptId: `${definition.id}-${condition}`,
    condition: {
      id: decodeEvaluationConditionId(condition),
      modelId: condition === "openclaw/v2" ? "openai/test" : "claude/test",
    },
    nanoclawApplicationImage: APPLICATION_IMAGE,
    runtimeStartupTimeoutMillis: 1_000,
    peerObservationTimeoutMillis: 2_000,
    caseTimeoutMillis: 3_000,
  };
}

it.effect(
  "executes every bundled case program with its exact peer topology",
  () =>
    Effect.forEach(
      evaluationCases,
      (definition) =>
        Effect.gen(function* () {
          const operations: string[] = [];
          const selected = yield* definition.program(
            programContext(operations),
          );
          const topology = Object.fromEntries(
            Object.entries(definition.peers).map(([name, peer]) => [
              name,
              peer.plan._tag,
            ]),
          );

          assert.deepStrictEqual(topology, EXPECTED_TOPOLOGY[definition.id]);
          assert.isAbove(definition.criteria.length, 0);
          assert.isAbove(definition.slices.length, 0);

          if (CROSS_CONVERSATION_CASES.has(definition.id)) {
            assert.strictEqual(selected, SOCIAL_EVIDENCE);
            assert.deepStrictEqual(operationNames(operations), [
              "instruct",
              "observe",
              "instruct",
              "select",
            ]);
            assert.strictEqual(operations[1], `observe:${SOURCE_AGENT_NAME}`);
            assert.strictEqual(operations[3], `select:${PROBE_AGENT_NAME}`);
            return;
          }

          assert.isAbove(operations.length, 0);
          assert.oneOf(selected, [PRINCIPAL_EVIDENCE, SOCIAL_EVIDENCE]);
        }),
      { concurrency: 1, discard: true },
    ),
);

it("materializes every case peer under both concrete runtime conditions", () => {
  const execution = {
    peerObservationTimeout: Duration.seconds(2),
    caseTimeout: Duration.seconds(3),
  } as const;
  const conditions = [
    openClawEvaluationCondition({
      runtime: { modelId: "openai/test" },
      execution,
    }),
    nanoclawEvaluationCondition({
      runtime: {
        applicationImage: APPLICATION_IMAGE,
        autoRegisterConversations: true,
        modelId: "claude/test",
      },
      execution,
    }),
  ] as const;
  const materialized: string[] = [];

  for (const definition of evaluationCases) {
    for (const condition of conditions) {
      condition.withDefinition({
        execute: (concrete) => {
          for (const peer of Object.values(definition.peers)) {
            assert.strictEqual(
              peer.runtime(APPLICATION_IMAGE).name,
              "evaluation-peer",
            );
          }
          materialized.push(
            `${definition.id}:${concrete.id}:${concrete.runtime.name}`,
          );
        },
      });
    }
  }

  assert.lengthOf(materialized, 32);
  assert.deepStrictEqual(
    conditions.map(({ id, runtimeName }) => [id, runtimeName]),
    [
      ["openclaw/v2", "openclaw"],
      ["nanoclaw/v2", "nanoclaw"],
    ],
  );
});

it("renders all 32 controller cells without injecting Client context", () => {
  const sources = evaluationCases.flatMap((definition) =>
    (["openclaw/v2", "nanoclaw/v2"] as const).map((condition) =>
      evaluationControllerModule(submission(definition, condition)),
    ),
  );

  assert.lengthOf(sources, 32);
  for (const source of sources) {
    assert.include(
      source,
      "peerApplicationImage: supportImageFromEnvironment()",
    );
    assert.notInclude(source, "@moltzap/client");
    assert.notInclude(source, "HarnessClient");
    assert.notInclude(source, "crossConversationContext");
  }
});
