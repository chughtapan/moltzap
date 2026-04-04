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
}

export interface JudgeResult {
  pass: boolean;
  reason: string;
  issues?: Array<{
    issue: string;
    severity: IssueSeverity;
  }>;
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
