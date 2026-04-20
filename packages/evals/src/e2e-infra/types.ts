/** Shared types for the E2E eval pipeline. */

import { Data } from "effect";

/**
 * Domain errors for the eval pipeline, used in Effect error channels where
 * typed failure flow is clearer than `errors: string[]` accumulation.
 *
 * Note: most phases still surface errors inside result records (the runner's
 * aggregate report needs per-scenario attribution), so these tags mainly show
 * up in the internal Effect channel before being captured back into the
 * result shape.
 */

/** Scenario generation failed (transport error, protocol timeout, etc.). */
export class ScenarioGenerationError extends Data.TaggedError(
  "ScenarioGenerationError",
)<{
  readonly scenarioId: string;
  readonly message: string;
}> {}

/** LLM judge flow failed in a way the retry loop couldn't recover from. */
export class JudgeError extends Data.TaggedError("JudgeError")<{
  readonly message: string;
  readonly fatal: boolean;
}> {}

/** Container lifecycle failed (start, wait, stop). Used by the nanoclaw
 * runtime path; the Docker runtime uses the per-phase tagged errors below. */
export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly containerName: string;
  readonly phase: "start" | "wait" | "stop" | "image";
  readonly message: string;
}> {}

/** Docker image inspect or auto-build failed. */
export class DockerImageError extends Data.TaggedError("DockerImageError")<{
  readonly imageName: string;
  readonly message: string;
}> {}

/** Container creation, workspace seeding, or gateway handshake failed. */
export class DockerStartError extends Data.TaggedError("DockerStartError")<{
  readonly containerName: string;
  readonly message: string;
}> {}

/** Channel health check did not observe the agent within the timeout. */
export class DockerHealthTimeoutError extends Data.TaggedError(
  "DockerHealthTimeoutError",
)<{
  readonly containerName: string;
  readonly timeoutMs: number;
  readonly message: string;
}> {}

/** `docker rm` (or the raw stop helper) failed for a container. */
export class DockerStopError extends Data.TaggedError("DockerStopError")<{
  readonly containerName: string;
  readonly message: string;
}> {}

/** Union of failure modes produced by `DockerManager`'s Effect-native API. */
export type DockerError =
  | DockerImageError
  | DockerStartError
  | DockerHealthTimeoutError
  | DockerStopError;

/** Sending a MoltZap message and waiting for the agent reply timed out. */
export class AgentResponseTimeoutError extends Data.TaggedError(
  "AgentResponseTimeoutError",
)<{
  readonly conversationId: string;
  readonly timeoutMs: number;
}> {}

export interface EvalScenario {
  id: string;
  name: string;
  description: string;
  setupMessage: string;
  /** Additional messages for multi-turn scenarios. Each turn waits for a response before sending the next. */
  followUpMessages?: string[];
  expectedBehavior: string;
  validationChecks: string[];
  /** Deterministic pass check. If provided and returns true, skip LLM judge. */
  deterministicPassCheck?: (response: string) => boolean;
  /** Deterministic fail check. If provided and returns true, auto-fail. */
  deterministicFailCheck?: (response: string) => boolean;
  /** For cross-conversation scenarios: message sent in a SECOND conversation after the setup. */
  crossConversationProbe?: string;
  /** Conversation type. Defaults to "dm". */
  conversationType?: "dm" | "group";
  /** For group scenarios: how many bystander agents (besides eval-runner and OpenClaw agent). */
  groupBystanders?: number;
  /** Messages sent by bystander agents before the eval message, to create realistic group context. */
  bystanderMessages?: string[];
}

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  conversationId: string;
  createdAt?: string;
}

export interface GeneratedResult {
  scenarioId: string;
  scenario: EvalScenario;
  modelName: string;
  runNumber: number;
  agentResponse: string;
  conversationContext: string;
  latencyMs: number;
  error?: string;
  /** Full multi-turn transcript. Includes conversationId for cross-conversation scenarios. */
  transcript?: TranscriptEntry[];
}

export interface ValidatedResult extends GeneratedResult {
  validationErrors: string[];
}

export interface E2ERunResult {
  results: ValidatedResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgLatencyMs: number;
  };
}
