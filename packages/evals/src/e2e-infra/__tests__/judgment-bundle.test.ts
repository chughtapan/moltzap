import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJudgmentBundle,
  buildTraceJudgmentBundle,
  writeJudgmentBundleArtifacts,
  type JudgmentBundleTraceEvent,
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
    const messageEvents = bundle.events.filter(
      (
        event,
      ): event is Extract<JudgmentBundleTraceEvent, { type: "message" }> =>
        event.type === "message",
    );
    expect(messageEvents.map((event) => event.text)).toEqual([
      "hello",
      "hello back",
    ]);
    expect(bundle.events.map((event) => event.type)).toEqual([
      "phase",
      "message",
      "message",
      "phase",
    ]);
    expect(bundle.outcomes[0]?.status).toBe("completed");
    expect(bundle.context?.transcript).toHaveLength(2);
    expect(bundle.metadata?.modelName).toBe("openclaw-eval");
  });

  it("builds trace-driven bundles through the shared helper", () => {
    const bundle = buildTraceJudgmentBundle({
      project: "moltzap-arena",
      runId: "arena-ARENA-000-1-openclaw-eval",
      scenario: {
        id: "ARENA-000",
        name: "arena canary",
        description: "Checks that arena preserves the shared-contract trace.",
        expectedBehavior: "keep the canary prompt and response intact",
        validationChecks: ["prompt preserved", "response preserved"],
        judgeRubric: "Verify content preservation only.",
      },
      runtime: "openclaw",
      modelName: "openclaw-eval",
      contractMode: "shared",
      agents: [
        {
          id: "agent-1",
          name: "Agent-1",
          role: "werewolf",
          promptInputs: { runNumber: 1 },
        },
      ],
      events: [
        {
          type: "message",
          from: "TaskMaster",
          to: "Agent-1",
          channel: "dm",
          text: "hello",
          ts: 2,
        },
        {
          type: "message",
          from: "Agent-1",
          channel: "dm",
          text: "/kill target:Agent-2",
          ts: 3,
        },
        {
          type: "state",
          snapshot: { phase: "night" },
          ts: 1,
        },
      ],
      outcomes: [
        {
          agentId: "agent-1",
          status: "completed",
          endedAt: "2026-04-19T00:00:03.000Z",
        },
      ],
      context: {
        conversationContext: '{"phase":"night"}',
        validationErrors: [],
      },
      metadata: {
        multiAgent: false,
      },
    });

    expect(bundle.events.map((event) => event.type)).toEqual([
      "state",
      "message",
      "message",
    ]);
    expect(bundle.requirements.judgeRubric).toBe(
      "Verify content preservation only.",
    );
    expect(bundle.agents[0]?.promptInputs).toMatchObject({
      modelName: "openclaw-eval",
      scenarioId: "ARENA-000",
      runNumber: 1,
      runtime: "openclaw",
    });
    expect(bundle.metadata?.modelName).toBe("openclaw-eval");
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
