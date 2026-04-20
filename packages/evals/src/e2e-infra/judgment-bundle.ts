import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  EvalScenario,
  GeneratedResult,
  ValidatedResult,
} from "./types.js";
import type { SharedContractTelemetryEvent } from "./telemetry.js";

type RuntimeKind = "openclaw" | "nanoclaw";

export type JudgmentBundleTraceEvent =
  | {
      type: "message";
      from: string;
      to?: string;
      channel: string;
      text: string;
      ts: number;
    }
  | {
      type: "phase";
      phase: string;
      round?: number;
      ts: number;
    }
  | {
      type: "action";
      agent: string;
      action: string;
      channel: string;
      ts: number;
    }
  | {
      type: "state";
      snapshot: Readonly<Record<string, unknown>>;
      ts: number;
    };

export interface ExecutionArtifact {
  _tag: "DockerBuildArtifact" | "DockerImageArtifact";
  contextPath?: string;
  dockerfilePath?: string;
  target?: string;
  buildArgs?: Readonly<Record<string, string>>;
  imageTag?: string;
  image?: string;
  pullPolicy?: "always" | "if-missing" | "never";
}

export interface AgentDeclaration {
  id: string;
  name: string;
  role?: string;
  artifact: ExecutionArtifact;
  promptInputs: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RunRequirements {
  expectedBehavior: string;
  validationChecks: ReadonlyArray<string>;
  judgeRubric?: string;
}

export interface AgentOutcome {
  agentId: string;
  status:
    | "completed"
    | "timed_out"
    | "failed_to_start"
    | "runtime_error"
    | "cancelled";
  startedAt?: string;
  endedAt: string;
  exitCode?: number;
  reason?: string;
}

export interface JudgmentBundle {
  runId: string;
  project: string;
  scenarioId: string;
  name: string;
  description: string;
  requirements: RunRequirements;
  agents: ReadonlyArray<AgentDeclaration>;
  events: ReadonlyArray<JudgmentBundleTraceEvent>;
  outcomes: ReadonlyArray<AgentOutcome>;
  context?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}

const ExecutionArtifactSchema = Type.Union([
  Type.Object(
    {
      _tag: Type.Literal("DockerBuildArtifact"),
      contextPath: Type.String(),
      dockerfilePath: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      buildArgs: Type.Optional(Type.Record(Type.String(), Type.String())),
      imageTag: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      _tag: Type.Literal("DockerImageArtifact"),
      image: Type.String(),
      pullPolicy: Type.Optional(
        Type.Union([
          Type.Literal("always"),
          Type.Literal("if-missing"),
          Type.Literal("never"),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
]);

const AgentDeclarationSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    role: Type.Optional(Type.String()),
    artifact: ExecutionArtifactSchema,
    promptInputs: Type.Record(Type.String(), Type.Unknown()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const RunRequirementsSchema = Type.Object(
  {
    expectedBehavior: Type.String(),
    validationChecks: Type.Array(Type.String()),
    judgeRubric: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const AgentOutcomeSchema = Type.Object(
  {
    agentId: Type.String(),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("timed_out"),
      Type.Literal("failed_to_start"),
      Type.Literal("runtime_error"),
      Type.Literal("cancelled"),
    ]),
    startedAt: Type.Optional(Type.String()),
    endedAt: Type.String(),
    exitCode: Type.Optional(Type.Number()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const JudgmentBundleTraceEventSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("message"),
      from: Type.String(),
      to: Type.Optional(Type.String()),
      channel: Type.String(),
      text: Type.String(),
      ts: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("phase"),
      phase: Type.String(),
      round: Type.Optional(Type.Number()),
      ts: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("action"),
      agent: Type.String(),
      action: Type.String(),
      channel: Type.String(),
      ts: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("state"),
      snapshot: Type.Record(Type.String(), Type.Unknown()),
      ts: Type.Number(),
    },
    { additionalProperties: false },
  ),
]);

export const JudgmentBundleSchema = Type.Object(
  {
    runId: Type.String(),
    project: Type.String(),
    scenarioId: Type.String(),
    name: Type.String(),
    description: Type.String(),
    requirements: RunRequirementsSchema,
    agents: Type.Array(AgentDeclarationSchema),
    events: Type.Array(JudgmentBundleTraceEventSchema),
    outcomes: Type.Array(AgentOutcomeSchema),
    context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

function statusFromResult(
  result: GeneratedResult | ValidatedResult,
): AgentOutcome["status"] {
  if (result.error) {
    return result.error.toLowerCase().includes("timeout")
      ? "timed_out"
      : "runtime_error";
  }
  return "completed";
}

function reasonFromResult(
  result: GeneratedResult | ValidatedResult,
): string | undefined {
  if (result.error) return result.error;
  if ("validationErrors" in result && result.validationErrors.length > 0) {
    return result.validationErrors.join("; ");
  }
  return undefined;
}

function buildAgentDeclaration(opts: {
  agentId: string;
  agentName: string;
  runtime: RuntimeKind;
  modelName: string;
  scenario: EvalScenario;
  runNumber: number;
}): AgentDeclaration {
  return {
    id: opts.agentId,
    name: opts.agentName,
    role: "primary eval agent",
    artifact: {
      _tag: "DockerImageArtifact",
      image: "moltzap-eval-agent:local",
      pullPolicy: "if-missing",
    },
    promptInputs: {
      modelName: opts.modelName,
      scenarioId: opts.scenario.id,
      runNumber: opts.runNumber,
      runtime: opts.runtime,
    },
    metadata: {
      runtime: opts.runtime,
      modelName: opts.modelName,
    },
  };
}

function outgoingMessagesFromScenario(scenario: EvalScenario): string[] {
  return [
    scenario.setupMessage,
    ...(scenario.followUpMessages ?? []),
    ...(scenario.crossConversationProbe !== undefined
      ? [scenario.crossConversationProbe]
      : []),
  ];
}

function agentResponsesFromResult(generated: GeneratedResult): string[] {
  const transcriptResponses = generated.transcript?.filter(
    (entry) => entry.role === "agent" && entry.text.trim() !== "",
  );
  if (transcriptResponses !== undefined && transcriptResponses.length > 0) {
    return transcriptResponses.map((entry) => entry.text);
  }
  return generated.agentResponse.trim() !== "" ? [generated.agentResponse] : [];
}

function mapTelemetryEventToTraceEvent(
  event: SharedContractTelemetryEvent,
  opts: {
    outgoingMessages: ReadonlyArray<string>;
    agentResponses: ReadonlyArray<string>;
    sentIndex: number;
    receivedIndex: number;
  },
): JudgmentBundleTraceEvent {
  switch (event._tag) {
    case "run.started":
      return {
        type: "phase",
        phase: "run.started",
        round: event.runNumber,
        ts: Date.parse(event.ts),
      };
    case "fleet.started":
      return {
        type: "state",
        snapshot: {
          runtime: event.runtime,
          agentNames: event.agentNames,
          serverUrl: event.serverUrl,
        },
        ts: Date.parse(event.ts),
      };
    case "fleet.stopped":
      return {
        type: "state",
        snapshot: {
          runtime: event.runtime,
          agentNames: event.agentNames,
          stopped: true,
        },
        ts: Date.parse(event.ts),
      };
    case "message.sent":
      return {
        type: "message",
        from: event.expectedSenderId,
        channel: event.conversationId,
        text: opts.outgoingMessages[opts.sentIndex] ?? "",
        ts: Date.parse(event.ts),
      };
    case "message.received":
      return {
        type: "message",
        from: event.senderId,
        channel: event.conversationId,
        text: opts.agentResponses[opts.receivedIndex] ?? "",
        ts: Date.parse(event.ts),
      };
    case "run.completed":
      return {
        type: "phase",
        phase: "run.completed",
        round: event.runNumber,
        ts: Date.parse(event.ts),
      };
  }
}

export function buildJudgmentBundle(opts: {
  project: string;
  runId: string;
  scenario: EvalScenario;
  generated: GeneratedResult;
  validated: ValidatedResult;
  agentId: string;
  agentName: string;
  runtime: RuntimeKind;
  telemetryEvents: ReadonlyArray<SharedContractTelemetryEvent>;
}): JudgmentBundle {
  let sentIndex = 0;
  let receivedIndex = 0;
  const outgoingMessages = outgoingMessagesFromScenario(opts.scenario);
  const agentResponses = agentResponsesFromResult(opts.generated);
  const events = opts.telemetryEvents.map((event) => {
    const traceEvent = mapTelemetryEventToTraceEvent(event, {
      outgoingMessages,
      agentResponses,
      sentIndex,
      receivedIndex,
    });
    if (event._tag === "message.sent") {
      sentIndex += 1;
    } else if (event._tag === "message.received") {
      receivedIndex += 1;
    }
    return traceEvent;
  });

  const bundle: JudgmentBundle = {
    runId: opts.runId,
    project: opts.project,
    scenarioId: opts.scenario.id,
    name: opts.scenario.name,
    description: opts.scenario.description,
    requirements: {
      expectedBehavior: opts.scenario.expectedBehavior,
      validationChecks: opts.scenario.validationChecks,
    },
    agents: [
      buildAgentDeclaration({
        agentId: opts.agentId,
        agentName: opts.agentName,
        runtime: opts.runtime,
        modelName: opts.generated.modelName,
        scenario: opts.scenario,
        runNumber: opts.generated.runNumber,
      }),
    ],
    events,
    outcomes: [
      {
        agentId: opts.agentId,
        status: statusFromResult(opts.validated),
        endedAt: new Date().toISOString(),
        reason: reasonFromResult(opts.validated),
      },
    ],
    context: {
      conversationContext: opts.generated.conversationContext,
      transcript: opts.generated.transcript ?? [],
      modelName: opts.generated.modelName,
      runtime: opts.runtime,
      validationErrors: opts.validated.validationErrors,
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      runNumber: opts.generated.runNumber,
    },
  };

  return Value.Parse(JudgmentBundleSchema, bundle);
}

export function writeJudgmentBundleArtifacts(
  bundle: JudgmentBundle,
  outputDir: string,
): { jsonPath: string; yamlPath: string } {
  Value.Parse(JudgmentBundleSchema, bundle);

  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = bundle.runId;
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const yamlPath = path.join(outputDir, `${baseName}.yaml`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`);
  fs.writeFileSync(yamlPath, `${yaml.dump(bundle, { noRefs: true })}`);

  return { jsonPath, yamlPath };
}

export function deriveJudgmentRunId(opts: {
  scenarioId: string;
  runNumber: number;
  modelName: string;
}): string {
  return `moltzap-${opts.scenarioId}-${opts.runNumber}-${opts.modelName.replace(/[^\w.-]+/g, "_")}`;
}
