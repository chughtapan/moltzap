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
  events: ReadonlyArray<SharedContractTelemetryEvent>;
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

const SharedContractTelemetryEventSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      _tag: Type.Literal("run.started"),
      ts: Type.String(),
      runId: Type.String(),
      scenarioId: Type.String(),
      runNumber: Type.Number(),
      runtime: Type.Union([Type.Literal("openclaw"), Type.Literal("nanoclaw")]),
      contractMode: Type.Union([
        Type.Literal("legacy"),
        Type.Literal("shared"),
      ]),
      modelName: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      _tag: Type.Literal("fleet.started"),
      ts: Type.String(),
      runtime: Type.Union([Type.Literal("openclaw"), Type.Literal("nanoclaw")]),
      agentNames: Type.Array(Type.String()),
      serverUrl: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      _tag: Type.Literal("fleet.stopped"),
      ts: Type.String(),
      runtime: Type.Union([Type.Literal("openclaw"), Type.Literal("nanoclaw")]),
      agentNames: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      _tag: Type.Literal("message.sent"),
      ts: Type.String(),
      scenarioId: Type.String(),
      runNumber: Type.Number(),
      conversationId: Type.String(),
      expectedSenderId: Type.String(),
      charCount: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      _tag: Type.Literal("message.received"),
      ts: Type.String(),
      scenarioId: Type.String(),
      runNumber: Type.Number(),
      conversationId: Type.String(),
      senderId: Type.String(),
      messageId: Type.String(),
      charCount: Type.Number(),
      latencyMs: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      _tag: Type.Literal("run.completed"),
      ts: Type.String(),
      runId: Type.String(),
      scenarioId: Type.String(),
      runNumber: Type.Number(),
      contractMode: Type.Union([
        Type.Literal("legacy"),
        Type.Literal("shared"),
      ]),
      status: Type.Union([
        Type.Literal("success"),
        Type.Literal("validation_failure"),
        Type.Literal("runtime_failure"),
        Type.Literal("aborted"),
      ]),
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
    events: Type.Array(SharedContractTelemetryEventSchema),
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

export function buildJudgmentBundle(opts: {
  project: string;
  runId: string;
  scenario: EvalScenario;
  generated: GeneratedResult;
  validated: ValidatedResult;
  agentId: string;
  agentName: string;
  runtime: RuntimeKind;
  contractMode: "legacy" | "shared";
  telemetryEvents: ReadonlyArray<SharedContractTelemetryEvent>;
}): JudgmentBundle {
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
    events: [...opts.telemetryEvents],
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
      contractMode: opts.contractMode,
      runtime: opts.runtime,
      validationErrors: opts.validated.validationErrors,
    },
    metadata: {
      contractMode: opts.contractMode,
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
