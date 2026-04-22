/**
 * MoltZap-owned eval runtime contracts used by the runtime-surface staging path.
 */

export type EvalScenarioDocumentPath = string & {
  readonly __brand: "EvalScenarioDocumentPath";
};

export type PlannedHarnessArtifactPath = string & {
  readonly __brand: "PlannedHarnessArtifactPath";
};

export type PlannedHarnessPathOrGlob = string & {
  readonly __brand: "PlannedHarnessPathOrGlob";
};

export type EvalResultsDirectory = string & {
  readonly __brand: "EvalResultsDirectory";
};

export type EvalRunId = string & {
  readonly __brand: "EvalRunId";
};

export type EvalRuntimeKind = "openclaw" | "nanoclaw";

export type EvalScenarioAssertion =
  | { readonly _tag: "ContainsText"; readonly text: string }
  | { readonly _tag: "OmitsText"; readonly text: string }
  | { readonly _tag: "MaxWordCount"; readonly maxWords: number }
  | { readonly _tag: "MatchesRegex"; readonly pattern: string };

export interface DirectMessageConversation {
  readonly _tag: "DirectMessage";
  readonly setupMessage: string;
  readonly followUpMessages: readonly string[];
}

export interface GroupConversation {
  readonly _tag: "GroupConversation";
  readonly setupMessage: string;
  readonly followUpMessages: readonly string[];
  readonly bystanderCount: number;
  readonly bystanderMessages: readonly string[];
}

export interface CrossConversation {
  readonly _tag: "CrossConversation";
  readonly setupMessage: string;
  readonly followUpMessages: readonly string[];
  readonly probeMessage: string;
}

export type EvalScenarioConversation =
  | DirectMessageConversation
  | GroupConversation
  | CrossConversation;

export interface MoltZapEvalScenarioDocument {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly runtime: EvalRuntimeKind;
  readonly conversation: EvalScenarioConversation;
  readonly expectedBehavior: string;
  readonly assertions: readonly EvalScenarioAssertion[];
  readonly resultsSubdirectory?: string;
}

export interface StagedPlannedHarnessArtifact {
  readonly sourcePath: EvalScenarioDocumentPath;
  readonly scenarioId: string;
  readonly plannedHarnessPath: PlannedHarnessArtifactPath;
}

export type PlannedHarnessExecutionInput =
  | {
      readonly _tag: "SingleDocument";
      readonly pathOrGlob: PlannedHarnessPathOrGlob;
      readonly matchedDocument: PlannedHarnessArtifactPath;
    }
  | {
      readonly _tag: "DocumentGlob";
      readonly pathOrGlob: PlannedHarnessPathOrGlob;
      readonly matchedDocuments: readonly [
        PlannedHarnessArtifactPath,
        PlannedHarnessArtifactPath,
        ...PlannedHarnessArtifactPath[],
      ];
    };

export interface StagedPlannedHarnessCatalog {
  readonly artifacts: readonly [
    StagedPlannedHarnessArtifact,
    ...StagedPlannedHarnessArtifact[],
  ];
  readonly executionInput: PlannedHarnessExecutionInput;
}

export type LegacyEvalSurface =
  | "llm-judge"
  | "report"
  | "judgment-bundle"
  | "nanoclaw-smoke";

export type EvalExecutionMode =
  | {
      readonly _tag: "CcJudgeDefault";
      readonly plannedHarnessInput: PlannedHarnessExecutionInput;
    }
  | {
      readonly _tag: "LegacyLlmJudgeExplicit";
      readonly requestedBy: "cli-flag" | "unsupported-runtime";
      readonly surface: LegacyEvalSurface;
    };

export interface EvalRunRequest {
  readonly scenarioDocuments: readonly [
    EvalScenarioDocumentPath,
    ...EvalScenarioDocumentPath[],
  ];
  readonly runtime: EvalRuntimeKind;
  readonly resultsDirectory: EvalResultsDirectory;
  readonly retainArtifacts: boolean;
  readonly requestedMode?: "cc-judge" | "legacy-llm-judge";
}

export interface EvalRunReceipt {
  readonly runId: EvalRunId;
  readonly executionMode: EvalExecutionMode;
  readonly resultsDirectory: EvalResultsDirectory;
  readonly stagedHarness: StagedPlannedHarnessCatalog;
}
