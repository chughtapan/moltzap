/**
 * Architecture-only contract for MoltZap eval scenario loading and staging.
 *
 * Implementers fill this in during the approved runtime cleanup slice.
 */

import { Data, Effect } from "effect";
import type {
  EvalResultsDirectory,
  EvalScenarioDocumentPath,
  MoltZapEvalScenarioDocument,
  StagedPlannedHarnessCatalog,
} from "./types.js";

export interface LoadedEvalScenarioDocument {
  readonly sourcePath: EvalScenarioDocumentPath;
  readonly document: MoltZapEvalScenarioDocument;
}

export class EvalScenarioSourceError extends Data.TaggedError(
  "EvalScenarioSourceError",
)<{
  readonly cause:
    | {
        readonly _tag: "ScenarioFileMissing";
        readonly path: string;
      }
    | {
        readonly _tag: "ScenarioYamlInvalid";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "ScenarioSchemaInvalid";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "ConversationDocumentInvalid";
        readonly path: string;
        readonly conversationTag:
          | "DirectMessage"
          | "GroupConversation"
          | "CrossConversation";
        readonly message: string;
      }
    | {
        readonly _tag: "DeterministicCallbackNotSupported";
        readonly path: string;
        readonly field: "deterministicPassCheck" | "deterministicFailCheck";
      }
    | {
        readonly _tag: "DuplicateScenarioId";
        readonly scenarioId: string;
        readonly paths: readonly [
          EvalScenarioDocumentPath,
          EvalScenarioDocumentPath,
        ];
      };
}> {}

export function loadEvalScenarioDocuments(
  _paths: readonly EvalScenarioDocumentPath[],
): Effect.Effect<
  readonly LoadedEvalScenarioDocument[],
  EvalScenarioSourceError,
  never
> {
  throw new Error("not implemented");
}

export function stagePlannedHarnessArtifacts(_input: {
  readonly documents: readonly LoadedEvalScenarioDocument[];
  readonly resultsDirectory: EvalResultsDirectory;
}): Effect.Effect<StagedPlannedHarnessCatalog, EvalScenarioSourceError, never> {
  throw new Error("not implemented");
}
