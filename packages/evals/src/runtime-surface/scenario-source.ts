import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { Data, Effect } from "effect";
import type {
  EvalResultsDirectory,
  EvalScenarioAssertion,
  EvalScenarioDocumentPath,
  MoltZapEvalScenarioDocument,
  PlannedHarnessArtifactPath,
  PlannedHarnessExecutionInput,
  PlannedHarnessPathOrGlob,
  StagedPlannedHarnessArtifact,
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

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: sourcePath,
        message: `${field} must be a non-empty string`,
      },
    });
  }
  return value;
}

function asOptionalStringArray(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
  field: string,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: sourcePath,
        message: `${field} must be an array of non-empty strings`,
      },
    });
  }
  return value;
}

function asRuntimeKind(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
): "openclaw" | "nanoclaw" {
  if (value === "openclaw" || value === "nanoclaw") {
    return value;
  }
  throw new EvalScenarioSourceError({
    cause: {
      _tag: "ScenarioSchemaInvalid",
      path: sourcePath,
      message: "runtime must be either openclaw or nanoclaw",
    },
  });
}

function asAssertion(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
  index: number,
): EvalScenarioAssertion {
  if (!isRecord(value) || typeof value["_tag"] !== "string") {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: sourcePath,
        message: `assertions[${String(index)}] must be an object with an _tag`,
      },
    });
  }

  switch (value["_tag"]) {
    case "ContainsText":
    case "OmitsText":
      return {
        _tag: value["_tag"],
        text: asNonEmptyString(
          value["text"],
          sourcePath,
          `assertions[${String(index)}].text`,
        ),
      };
    case "MaxWordCount": {
      const maxWords = value["maxWords"];
      if (!Number.isInteger(maxWords) || (maxWords as number) <= 0) {
        throw new EvalScenarioSourceError({
          cause: {
            _tag: "ScenarioSchemaInvalid",
            path: sourcePath,
            message: `assertions[${String(index)}].maxWords must be a positive integer`,
          },
        });
      }
      return {
        _tag: "MaxWordCount",
        maxWords: maxWords as number,
      };
    }
    case "MatchesRegex":
      return {
        _tag: "MatchesRegex",
        pattern: asNonEmptyString(
          value["pattern"],
          sourcePath,
          `assertions[${String(index)}].pattern`,
        ),
      };
    default:
      throw new EvalScenarioSourceError({
        cause: {
          _tag: "ScenarioSchemaInvalid",
          path: sourcePath,
          message: `assertions[${String(index)}]._tag must be one of ContainsText, OmitsText, MaxWordCount, MatchesRegex`,
        },
      });
  }
}

function asAssertions(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
): readonly EvalScenarioAssertion[] {
  if (!Array.isArray(value)) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: sourcePath,
        message: "assertions must be an array",
      },
    });
  }
  return value.map((entry, index) => asAssertion(entry, sourcePath, index));
}

function decodeConversation(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
): MoltZapEvalScenarioDocument["conversation"] {
  if (!isRecord(value) || typeof value["_tag"] !== "string") {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: sourcePath,
        message: "conversation must be an object with an _tag",
      },
    });
  }

  switch (value["_tag"]) {
    case "DirectMessage":
      return {
        _tag: "DirectMessage",
        setupMessage: asNonEmptyString(
          value["setupMessage"],
          sourcePath,
          "conversation.setupMessage",
        ),
        followUpMessages: asOptionalStringArray(
          value["followUpMessages"],
          sourcePath,
          "conversation.followUpMessages",
        ),
      };
    case "GroupConversation": {
      const bystanderCount = value["bystanderCount"];
      const bystanderMessages = asOptionalStringArray(
        value["bystanderMessages"],
        sourcePath,
        "conversation.bystanderMessages",
      );
      if (
        !Number.isInteger(bystanderCount) ||
        (bystanderCount as number) < 0
      ) {
        throw new EvalScenarioSourceError({
          cause: {
            _tag: "ConversationDocumentInvalid",
            path: sourcePath,
            conversationTag: "GroupConversation",
            message: "bystanderCount must be a non-negative integer",
          },
        });
      }
      if (bystanderMessages.length > (bystanderCount as number)) {
        throw new EvalScenarioSourceError({
          cause: {
            _tag: "ConversationDocumentInvalid",
            path: sourcePath,
            conversationTag: "GroupConversation",
            message: "bystanderMessages cannot exceed bystanderCount",
          },
        });
      }
      return {
        _tag: "GroupConversation",
        setupMessage: asNonEmptyString(
          value["setupMessage"],
          sourcePath,
          "conversation.setupMessage",
        ),
        followUpMessages: asOptionalStringArray(
          value["followUpMessages"],
          sourcePath,
          "conversation.followUpMessages",
        ),
        bystanderCount: bystanderCount as number,
        bystanderMessages,
      };
    }
    case "CrossConversation":
      return {
        _tag: "CrossConversation",
        setupMessage: asNonEmptyString(
          value["setupMessage"],
          sourcePath,
          "conversation.setupMessage",
        ),
        followUpMessages: asOptionalStringArray(
          value["followUpMessages"],
          sourcePath,
          "conversation.followUpMessages",
        ),
        probeMessage: asNonEmptyString(
          value["probeMessage"],
          sourcePath,
          "conversation.probeMessage",
        ),
      };
    default:
      throw new EvalScenarioSourceError({
        cause: {
          _tag: "ScenarioSchemaInvalid",
          path: sourcePath,
          message: "conversation._tag must be DirectMessage, GroupConversation, or CrossConversation",
        },
      });
  }
}

function decodeDocument(
  value: unknown,
  sourcePath: EvalScenarioDocumentPath,
): MoltZapEvalScenarioDocument {
  if (!isRecord(value)) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: sourcePath,
        message: "scenario document must decode to an object",
      },
    });
  }

  if ("deterministicPassCheck" in value) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "DeterministicCallbackNotSupported",
        path: sourcePath,
        field: "deterministicPassCheck",
      },
    });
  }
  if ("deterministicFailCheck" in value) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "DeterministicCallbackNotSupported",
        path: sourcePath,
        field: "deterministicFailCheck",
      },
    });
  }

  return {
    id: asNonEmptyString(value["id"], sourcePath, "id"),
    name: asNonEmptyString(value["name"], sourcePath, "name"),
    description: asNonEmptyString(
      value["description"],
      sourcePath,
      "description",
    ),
    runtime: asRuntimeKind(value["runtime"], sourcePath),
    conversation: decodeConversation(value["conversation"], sourcePath),
    expectedBehavior: asNonEmptyString(
      value["expectedBehavior"],
      sourcePath,
      "expectedBehavior",
    ),
    assertions: asAssertions(value["assertions"], sourcePath),
    ...(typeof value["resultsSubdirectory"] === "string" &&
    value["resultsSubdirectory"].trim().length > 0
      ? { resultsSubdirectory: value["resultsSubdirectory"] }
      : {}),
  };
}

function brandPath<T extends string>(
  value: string,
  _brand: T,
): string & { readonly __brand: T } {
  return value as string & { readonly __brand: T };
}

function loadOneScenario(
  sourcePath: EvalScenarioDocumentPath,
): LoadedEvalScenarioDocument {
  if (!existsSync(sourcePath)) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioFileMissing",
        path: sourcePath,
      },
    });
  }

  const source = readFileSync(sourcePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioYamlInvalid",
        path: sourcePath,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  return {
    sourcePath,
    document: decodeDocument(parsed, sourcePath),
  };
}

function assertionToValidationCheck(assertion: EvalScenarioAssertion): string {
  switch (assertion._tag) {
    case "ContainsText":
      return `Response contains '${assertion.text}'`;
    case "OmitsText":
      return `Response omits '${assertion.text}'`;
    case "MaxWordCount":
      return `Response stays within ${String(assertion.maxWords)} words`;
    case "MatchesRegex":
      return `Response matches regex ${assertion.pattern}`;
  }
}

function promptsForConversation(
  conversation: MoltZapEvalScenarioDocument["conversation"],
): readonly [string, ...string[]] {
  switch (conversation._tag) {
    case "DirectMessage":
      return [conversation.setupMessage, ...conversation.followUpMessages];
    case "GroupConversation": {
      const groupSetup =
        conversation.bystanderMessages.length === 0
          ? conversation.setupMessage
          : `${conversation.bystanderMessages
              .map((message, index) => `Bystander ${String(index + 1)}: ${message}`)
              .join("\n")}\n\n${conversation.setupMessage}`;
      return [groupSetup, ...conversation.followUpMessages];
    }
    case "CrossConversation":
      return [
        conversation.setupMessage,
        ...conversation.followUpMessages,
        `[Cross-conversation probe]\n${conversation.probeMessage}`,
      ];
  }
}

function toPlannedHarnessDocument(
  loaded: LoadedEvalScenarioDocument,
) {
  const prompts = promptsForConversation(loaded.document.conversation);
  return {
    plan: {
      project: "moltzap",
      scenarioId: loaded.document.id,
      name: loaded.document.name,
      description: loaded.document.description,
      agents: [
        {
          id: "moltzap-primary-agent",
          name: "moltzap-primary-agent",
          role: "primary eval agent",
          artifact: {
            _tag: "DockerImageArtifact",
            image: "moltzap-eval-agent:local",
            pullPolicy: "if-missing",
          },
          promptInputs: {
            runtime: loaded.document.runtime,
            conversationTag: loaded.document.conversation._tag,
          },
          metadata: {
            runtime: loaded.document.runtime,
            conversationTag: loaded.document.conversation._tag,
            sourcePath: loaded.sourcePath,
          },
        },
      ],
      requirements: {
        expectedBehavior: loaded.document.expectedBehavior,
        validationChecks: loaded.document.assertions.map((assertion) =>
          assertionToValidationCheck(assertion),
        ),
      },
      metadata: {
        sourcePath: loaded.sourcePath,
        runtime: loaded.document.runtime,
      },
    },
    harness: {
      kind: "prompt-workspace",
      config: {
        prompts,
      },
    },
  };
}

function toExecutionInput(
  plannedHarnessDir: string,
  artifacts: readonly [
    StagedPlannedHarnessArtifact,
    ...StagedPlannedHarnessArtifact[],
  ],
): PlannedHarnessExecutionInput {
  if (artifacts.length === 1) {
    const [artifact] = artifacts;
    return {
      _tag: "SingleDocument",
      pathOrGlob: brandPath(
        artifact.plannedHarnessPath,
        "PlannedHarnessPathOrGlob",
      ) as PlannedHarnessPathOrGlob,
      matchedDocument: artifact.plannedHarnessPath,
    };
  }

  const matchedDocuments = toMatchedDocumentsTuple(artifacts);

  return {
    _tag: "DocumentGlob",
    pathOrGlob: brandPath(
      path.join(plannedHarnessDir, "*.yaml"),
      "PlannedHarnessPathOrGlob",
    ),
    matchedDocuments,
  };
}

function toMatchedDocumentsTuple(
  artifacts: readonly [
    StagedPlannedHarnessArtifact,
    ...StagedPlannedHarnessArtifact[],
  ],
): readonly [
  PlannedHarnessArtifactPath,
  PlannedHarnessArtifactPath,
  ...PlannedHarnessArtifactPath[],
] {
  const [first, second, ...rest] = artifacts.map(
    (artifact) => artifact.plannedHarnessPath,
  );
  if (first === undefined || second === undefined) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: "(planned-harness)",
        message: "document glob execution requires at least two artifacts",
      },
    });
  }
  return [first, second, ...rest];
}

function toArtifactTuple(
  artifacts: readonly StagedPlannedHarnessArtifact[],
): readonly [
  StagedPlannedHarnessArtifact,
  ...StagedPlannedHarnessArtifact[],
] {
  const [first, ...rest] = artifacts;
  if (first === undefined) {
    throw new EvalScenarioSourceError({
      cause: {
        _tag: "ScenarioSchemaInvalid",
        path: "(planned-harness)",
        message: "at least one staged artifact is required",
      },
    });
  }
  return [first, ...rest];
}

export function loadEvalScenarioDocuments(
  paths: readonly EvalScenarioDocumentPath[],
): Effect.Effect<
  readonly LoadedEvalScenarioDocument[],
  EvalScenarioSourceError,
  never
> {
  return Effect.try({
    try: () => {
      const loaded = paths.map((sourcePath) => loadOneScenario(sourcePath));
      const seen = new Map<string, EvalScenarioDocumentPath>();

      for (const document of loaded) {
        const previousPath = seen.get(document.document.id);
        if (previousPath !== undefined) {
          throw new EvalScenarioSourceError({
            cause: {
              _tag: "DuplicateScenarioId",
              scenarioId: document.document.id,
              paths: [previousPath, document.sourcePath],
            },
          });
        }
        seen.set(document.document.id, document.sourcePath);
      }

      return loaded;
    },
    catch: (error) =>
      error instanceof EvalScenarioSourceError
        ? error
        : new EvalScenarioSourceError({
            cause: {
              _tag: "ScenarioYamlInvalid",
              path: "(unknown)",
              message: error instanceof Error ? error.message : String(error),
            },
          }),
  });
}

export function stagePlannedHarnessArtifacts(input: {
  readonly documents: readonly LoadedEvalScenarioDocument[];
  readonly resultsDirectory: EvalResultsDirectory;
}): Effect.Effect<StagedPlannedHarnessCatalog, EvalScenarioSourceError, never> {
  return Effect.try({
    try: () => {
      if (input.documents.length === 0) {
        throw new EvalScenarioSourceError({
          cause: {
            _tag: "ScenarioSchemaInvalid",
            path: input.resultsDirectory,
            message: "at least one scenario document is required",
          },
        });
      }

      const plannedHarnessDir = path.join(
        input.resultsDirectory,
        "planned-harness",
      );
      mkdirSync(plannedHarnessDir, { recursive: true });

      const artifacts = toArtifactTuple(
        input.documents.map((loaded) => {
          const filename = `${loaded.document.id}.yaml`;
          const plannedHarnessPath = brandPath(
            path.join(plannedHarnessDir, filename),
            "PlannedHarnessArtifactPath",
          );
          writeFileSync(
            plannedHarnessPath,
            stringifyYaml(toPlannedHarnessDocument(loaded)),
          );
          return {
            sourcePath: loaded.sourcePath,
            scenarioId: loaded.document.id,
            plannedHarnessPath,
          } satisfies StagedPlannedHarnessArtifact;
        }),
      );

      return {
        artifacts,
        executionInput: toExecutionInput(plannedHarnessDir, artifacts),
      };
    },
    catch: (error) =>
      error instanceof EvalScenarioSourceError
        ? error
        : new EvalScenarioSourceError({
            cause: {
              _tag: "ScenarioYamlInvalid",
              path: input.resultsDirectory,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
  });
}
