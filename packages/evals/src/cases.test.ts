import { assert, describe, it } from "@effect/vitest";
import { agentId } from "@moltzap/protocol/testing";
import { makeAgentHandle } from "@moltzap/simulator/network";
import { Effect, Option } from "effect";
import {
  OBSERVER_1_AGENT_NAME,
  OBSERVER_2_AGENT_NAME,
  PEER_AGENT_NAME,
  SOURCE_AGENT_NAME,
  TARGET_AGENT_NAME,
  evaluationCases,
  type BundledEvaluationCase,
  type CriterionEvidence,
  type EvaluationCasePeer,
  type EvaluationCasePeers,
  type EvaluationCaseProgramContext,
} from "./cases.js";
import {
  CriterionDecided,
  decodeEvaluationCaseId,
  decodeEvaluationEvidenceId,
} from "./model.js";
import type {
  EvaluationPeerDefinition,
  EvaluationPeerGateway,
} from "./peer.js";

const test = it.effect;
const OBSERVE_PEER_OPERATION = "observe:peer";
const SELECT_PEER_OPERATION = "select-peer:peer";
const SELECT_PRINCIPAL_OPERATION = "select-principal";
const PRINCIPAL_OUTPUT_ID = decodeEvaluationEvidenceId(
  "case-test:principal-output",
);
const PEER_OUTPUT_ID = decodeEvaluationEvidenceId("case-test:peer-output");
const PASSED_VERDICT = "passed";

type DirectTestPeerDefinitions = Readonly<{
  [PEER_AGENT_NAME]: EvaluationPeerDefinition;
}>;

function evidence(text: string): CriterionEvidence {
  return {
    selected: [
      {
        evidenceId: decodeEvaluationEvidenceId("case-test:selected"),
        source: "gateway",
        parts: [{ type: "text", text }],
      },
    ],
  };
}

function idleGateway(): EvaluationPeerGateway {
  return { exchange: Effect.never };
}

function peer<const Name extends string>(
  name: Name,
  id: string,
): EvaluationCasePeer<Name> {
  return {
    agent: makeAgentHandle(name, agentId(id)),
    gateway: idleGateway(),
    termination: Effect.never,
  };
}

function peers(): EvaluationCasePeers<DirectTestPeerDefinitions> {
  return {
    [PEER_AGENT_NAME]: peer(
      PEER_AGENT_NAME,
      "00000000-0000-4000-8000-000000000101",
    ),
  };
}

interface ProgramRecorder {
  readonly context: EvaluationCaseProgramContext<
    DirectTestPeerDefinitions,
    never
  >;
  readonly operations: readonly string[];
}

function programRecorder(): ProgramRecorder {
  const roster = peers();
  const names = new Map<EvaluationCasePeer, string>([
    [roster[PEER_AGENT_NAME], "peer"],
  ]);
  const operations: string[] = [];
  const context: EvaluationCaseProgramContext<
    DirectTestPeerDefinitions,
    never
  > = {
    peers: roster,
    instruct: (message) =>
      Effect.sync(() => {
        operations.push(`instruct:${message}`);
        return Option.some(PRINCIPAL_OUTPUT_ID);
      }),
    selectPrincipalOutput: (output) =>
      Effect.sync(() => {
        operations.push(SELECT_PRINCIPAL_OPERATION);
        return Option.getOrThrow(output);
      }),
    observeContext: (observed) =>
      Effect.sync(() => {
        operations.push(`observe:${names.get(observed) ?? "unknown"}`);
      }),
    selectPeerOutput: (observed) =>
      Effect.sync(() => {
        operations.push(`select-peer:${names.get(observed) ?? "unknown"}`);
        return PEER_OUTPUT_ID;
      }),
  };
  return { context, operations };
}

function assertFrozenDefinition(definition: BundledEvaluationCase): void {
  assert.isTrue(Object.isFrozen(definition));
  assert.isTrue(Object.isFrozen(definition.peers));
  assert.isTrue(Object.isFrozen(definition.program));
  assert.isTrue(Object.isFrozen(definition.slices));
  assert.isTrue(Object.isFrozen(definition.criteria));
  for (const entry of definition.criteria) {
    assert.isTrue(Object.isFrozen(entry));
    assert.isTrue(Object.isFrozen(entry.criterion));
    assert.isTrue(Object.isFrozen(entry.decide));
  }
}

function catalogTest(): void {
  assert.deepStrictEqual(
    evaluationCases.map(({ id }) => id),
    [
      "EVAL-005",
      "EVAL-006",
      "EVAL-007",
      "EVAL-009",
      "EVAL-010",
      "EVAL-011",
      "EVAL-018",
      "EVAL-019",
      "EVAL-021",
      "EVAL-022",
    ],
  );
  assert.isTrue(Object.isFrozen(evaluationCases));
  for (const definition of evaluationCases) {
    assertFrozenDefinition(definition);
  }
}

function exactPeerRostersTest(): void {
  assert.deepStrictEqual(
    evaluationCases.map((definition) => Object.keys(definition.peers)),
    [
      [PEER_AGENT_NAME],
      [PEER_AGENT_NAME, SOURCE_AGENT_NAME, OBSERVER_1_AGENT_NAME],
      [PEER_AGENT_NAME],
      [PEER_AGENT_NAME],
      [PEER_AGENT_NAME, SOURCE_AGENT_NAME, OBSERVER_1_AGENT_NAME],
      [PEER_AGENT_NAME, OBSERVER_1_AGENT_NAME, OBSERVER_2_AGENT_NAME],
      [PEER_AGENT_NAME],
      [],
      [PEER_AGENT_NAME],
      [PEER_AGENT_NAME],
    ],
  );
  assert.isFalse(
    evaluationCases.some((definition) => TARGET_AGENT_NAME in definition.peers),
  );
}

function principalBoundaryTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[0];
    assert.strictEqual(definition.id, decodeEvaluationCaseId("EVAL-005"));
    const recorder = programRecorder();

    const selectedEventId = yield* definition.program(recorder.context);

    assert.lengthOf(recorder.operations, 2);
    assert.match(
      recorder.operations[0] ?? "",
      new RegExp(`^instruct:.*${PEER_AGENT_NAME}`, "u"),
    );
    assert.strictEqual(recorder.operations[1], SELECT_PEER_OPERATION);
    assert.strictEqual(selectedEventId, PEER_OUTPUT_ID);
    assert.notInclude(Object.keys(definition.peers), TARGET_AGENT_NAME);
    assert.deepStrictEqual(Object.keys(recorder.context), [
      "peers",
      "instruct",
      "selectPrincipalOutput",
      "observeContext",
      "selectPeerOutput",
    ]);
  });
}

function identityProgramTest() {
  return Effect.gen(function* () {
    const definition = evaluationCases[9];
    assert.strictEqual(definition.id, decodeEvaluationCaseId("EVAL-022"));
    const recorder = programRecorder();

    const selectedEventId = yield* definition.program(recorder.context);

    assert.strictEqual(recorder.operations[0], OBSERVE_PEER_OPERATION);
    assert.match(
      recorder.operations[1] ?? "",
      /^instruct:Which MoltZap agent most recently contacted you/u,
    );
    assert.strictEqual(recorder.operations[2], SELECT_PRINCIPAL_OPERATION);
    assert.lengthOf(recorder.operations, 3);
    assert.strictEqual(selectedEventId, PRINCIPAL_OUTPUT_ID);
    const decision = definition.criteria[0].decide(evidence(PEER_AGENT_NAME));
    assert.instanceOf(decision, CriterionDecided);
    if (decision instanceof CriterionDecided) {
      assert.strictEqual(decision.verdict, PASSED_VERDICT);
      assert.deepStrictEqual(decision.citations, [
        decodeEvaluationEvidenceId("case-test:selected"),
      ]);
    }
  });
}

// @agent-code-guard/regression-only: catalog identity, immutability, and code policy order are public evaluation contracts
describe("evaluation case catalog", () => {
  it("owns the exact ordered immutable ten-case catalog", catalogTest);
  it("starts only the autonomous peers each case uses", exactPeerRostersTest);
  test(
    "returns one social evidence identity without exposing selection state",
    principalBoundaryTest,
  );
  test(
    "returns one principal evidence identity after the autonomous peer contacts the target",
    identityProgramTest,
  );
});
