import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJudgmentBundle,
  writeJudgmentBundleArtifacts,
} from "../judgment-bundle.js";
import type {
  EvalScenario,
  GeneratedResult,
  ValidatedResult,
} from "../types.js";
import {
  createFleetStartedTelemetryEvent,
  createMessageReceivedTelemetryEvent,
  createMessageSentTelemetryEvent,
  createRunCompletedTelemetryEvent,
  createRunStartedTelemetryEvent,
  type SharedContractTelemetryEvent,
} from "../telemetry.js";

const SCENARIO: EvalScenario = {
  id: "EVAL-001",
  name: "basic eval",
  description: "Checks that the agent answers politely.",
  setupMessage: "hello",
  expectedBehavior: "answer politely",
  validationChecks: ["response is non-empty"],
};

const GENERATED: GeneratedResult = {
  scenarioId: SCENARIO.id,
  scenario: SCENARIO,
  modelName: "openclaw-eval",
  runNumber: 1,
  agentResponse: "hello back",
  conversationContext: JSON.stringify({
    conversationId: "conv-1",
    senderId: "agent-1",
    messageId: "msg-1",
    parts: [{ type: "text", text: "hello back" }],
    createdAt: "2026-04-19T00:00:02.000Z",
  }),
  latencyMs: 42,
  transcript: [
    {
      role: "user",
      text: "hello",
      conversationId: "conv-1",
      createdAt: "2026-04-19T00:00:00.000Z",
    },
    {
      role: "agent",
      text: "hello back",
      conversationId: "conv-1",
      createdAt: "2026-04-19T00:00:02.000Z",
    },
  ],
};

const VALIDATED: ValidatedResult = {
  ...GENERATED,
  validationErrors: [],
};

const EVENTS: SharedContractTelemetryEvent[] = [
  createRunStartedTelemetryEvent({
    ts: "2026-04-19T00:00:00.000Z",
    runId: "moltzap-EVAL-001-1-openclaw-eval",
    scenarioId: SCENARIO.id,
    runNumber: 1,
    runtime: "openclaw",
    contractMode: "shared",
    modelName: "openclaw-eval",
  }),
  createMessageSentTelemetryEvent({
    ts: "2026-04-19T00:00:00.000Z",
    scenarioId: SCENARIO.id,
    runNumber: 1,
    conversationId: "conv-1",
    expectedSenderId: "agent-1",
    charCount: 5,
  }),
  createMessageReceivedTelemetryEvent({
    ts: "2026-04-19T00:00:02.000Z",
    scenarioId: SCENARIO.id,
    runNumber: 1,
    conversationId: "conv-1",
    senderId: "agent-1",
    messageId: "msg-1",
    charCount: 10,
    latencyMs: 42,
  }),
  createRunCompletedTelemetryEvent({
    ts: "2026-04-19T00:00:03.000Z",
    runId: "moltzap-EVAL-001-1-openclaw-eval",
    scenarioId: SCENARIO.id,
    runNumber: 1,
    contractMode: "shared",
    status: "success",
  }),
];

describe("buildJudgmentBundle", () => {
  it("builds and validates a shared-contract bundle", () => {
    const bundle = buildJudgmentBundle({
      project: "moltzap",
      runId: "moltzap-EVAL-001-1-openclaw-eval",
      scenario: SCENARIO,
      generated: GENERATED,
      validated: VALIDATED,
      agentId: "agent-1",
      agentName: "openclaw-eval-agent",
      runtime: "openclaw",
      contractMode: "shared",
      telemetryEvents: EVENTS,
    });

    expect(bundle.project).toBe("moltzap");
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.events).toHaveLength(4);
    expect(bundle.events.map((event) => event.type)).toEqual([
      "phase",
      "message",
      "message",
      "phase",
    ]);
    expect(bundle.outcomes[0]?.status).toBe("completed");
    expect(bundle.context?.transcript).toHaveLength(2);
  });

  it("writes JSON and YAML bundle artifacts", () => {
    const bundle = buildJudgmentBundle({
      project: "moltzap",
      runId: "moltzap-EVAL-001-1-openclaw-eval",
      scenario: SCENARIO,
      generated: GENERATED,
      validated: VALIDATED,
      agentId: "agent-1",
      agentName: "openclaw-eval-agent",
      runtime: "openclaw",
      contractMode: "shared",
      telemetryEvents: EVENTS,
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moltzap-bundle-"));
    const paths = writeJudgmentBundleArtifacts(bundle, dir);

    expect(fs.existsSync(paths.jsonPath)).toBe(true);
    expect(fs.existsSync(paths.yamlPath)).toBe(true);
    expect(fs.readFileSync(paths.jsonPath, "utf8")).toContain(
      "moltzap-EVAL-001-1-openclaw-eval",
    );
  });
});
