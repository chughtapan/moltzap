/** Shared types for the E2E eval pipeline. */

export type IssueSeverity = "minor" | "significant" | "critical";

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

export interface JudgeResult {
  pass: boolean;
  reason: string;
  issues?: Array<{
    issue: string;
    severity: IssueSeverity;
  }>;
}

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  conversationId: string;
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

export interface EvaluatedResult extends ValidatedResult {
  judgeResult?: JudgeResult & {
    overallSeverity?: IssueSeverity;
    evalPrompt?: string;
  };
}

export interface E2ERunResult {
  results: EvaluatedResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgLatencyMs: number;
  };
}
