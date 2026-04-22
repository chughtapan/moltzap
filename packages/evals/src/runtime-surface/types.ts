/**
 * Architecture-only contracts for MoltZap-owned eval runtime surfaces.
 *
 * Implementers fill this in during the approved runtime cleanup slice.
 */

export type EvalScenarioDocumentPath = string & {
  readonly __brand: "EvalScenarioDocumentPath";
};

export type PlannedHarnessArtifactPath = string & {
  readonly __brand: "PlannedHarnessArtifactPath";
};

export type EvalResultsDirectory = string & {
  readonly __brand: "EvalResultsDirectory";
};

export type EvalRunId = string & {
  readonly __brand: "EvalRunId";
};

export type EvalRuntimeKind = "openclaw" | "nanoclaw";

export type EvalConversationMode = "dm" | "group" | "cross-conversation";

export type EvalScenarioAssertion =
  | { readonly _tag: "ContainsText"; readonly text: string }
  | { readonly _tag: "OmitsText"; readonly text: string }
  | { readonly _tag: "MaxWordCount"; readonly maxWords: number }
  | { readonly _tag: "MatchesRegex"; readonly pattern: string };

export interface MoltZapEvalScenarioDocument {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly runtime: EvalRuntimeKind;
  readonly conversationMode: EvalConversationMode;
  readonly setupMessages: readonly string[];
  readonly expectedBehavior: string;
  readonly assertions: readonly EvalScenarioAssertion[];
  readonly resultsSubdirectory?: string;
}

export type LegacyEvalSurface =
  | "llm-judge"
  | "report"
  | "judgment-bundle"
  | "nanoclaw-smoke";

export type EvalExecutionMode =
  | {
      readonly _tag: "CcJudgeDefault";
      readonly plannedHarnessPath: PlannedHarnessArtifactPath;
    }
  | {
      readonly _tag: "LegacyLlmJudgeExplicit";
      readonly requestedBy: "cli-flag" | "unsupported-runtime";
      readonly surface: LegacyEvalSurface;
    };

export interface EvalRunRequest {
  readonly scenarioDocuments: readonly EvalScenarioDocumentPath[];
  readonly runtime: EvalRuntimeKind;
  readonly resultsDirectory: EvalResultsDirectory;
  readonly retainArtifacts: boolean;
  readonly requestedMode?: "cc-judge" | "legacy-llm-judge";
}

export interface EvalRunReceipt {
  readonly runId: EvalRunId;
  readonly executionMode: EvalExecutionMode;
  readonly resultsDirectory: EvalResultsDirectory;
  readonly stagedHarnesses: readonly PlannedHarnessArtifactPath[];
}
