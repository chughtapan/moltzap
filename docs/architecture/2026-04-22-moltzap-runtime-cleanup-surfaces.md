# MoltZap Runtime Cleanup Surfaces

## Summary

This slice freezes two upstream `@moltzap/server-core` surfaces and three `@moltzap/evals` surfaces so the implementation pass can remove Effect-version glue, route runtime logging through one shared observability contract, move MoltZap eval scenarios onto declarative planned-harness staging, and make `cc-judge` the default execution model without touching arena-owned files. The shape is: `server-core` owns normalized process config plus shared request/session/agent/fiber observability where helper combinators are total once bootstrap succeeds, while `evals` owns only MoltZap-specific scenario documents that explicitly mirror current DM, group, and cross-conversation behavior, plus staged planned-harness catalogs whose `pathOrGlob` selection aligns to the upstream `cc-judge run-plans <plan-path-or-glob>` ingress from `#167/#169`.

## Modules

1. `packages/server/src/runtime-surface/config.ts`
Purpose: normalize file-backed YAML config plus process-env overlays into one typed runtime bootstrap snapshot that downstream server and eval code can share.
Public surface: `RuntimeConfigPath`, `RuntimeEnvironment`, `RuntimeLogLevel`, `RuntimeLoggingConfig`, `RuntimeTracingConfig`, `LoadRuntimeConfigInput`, `RuntimeProcessConfig`, `RuntimeConfigSurfaceError`, `loadRuntimeProcessConfig(...)`.
Dependencies: `../config/effect-config.js`, `../config/loader.js`, `../app/config.js`, `effect`.

2. `packages/server/src/runtime-surface/logging.ts`
Purpose: upstream a shared observability contract around the existing Pino-plus-Effect logger shape, including typed request/session/agent/fiber annotations and a total post-bootstrap helper surface.
Public surface: `RuntimeRequestId`, `RuntimeSessionId`, `RuntimeAgentId`, `RuntimeFiberId`, `RuntimeSpanName`, `RuntimeLogContext`, `RuntimeTraceSpan`, `RuntimeObservability`, `RuntimeObservabilityError`, `createRuntimeObservability(...)`, `withRuntimeLogContext(...)`, `withRuntimeTraceSpan(...)`.
Dependencies: `../logger.js`, `./config.js`, `effect`.

3. `packages/evals/src/runtime-surface/types.ts`
Purpose: define the MoltZap-owned eval contracts that stay local after generic bundle / judge / report ownership moves to `cc-judge`.
Public surface: `EvalScenarioDocumentPath`, `PlannedHarnessArtifactPath`, `PlannedHarnessPathOrGlob`, `EvalResultsDirectory`, `EvalRunId`, `EvalRuntimeKind`, `EvalScenarioAssertion`, `DirectMessageConversation`, `GroupConversation`, `CrossConversation`, `EvalScenarioConversation`, `MoltZapEvalScenarioDocument`, `StagedPlannedHarnessArtifact`, `PlannedHarnessExecutionInput`, `StagedPlannedHarnessCatalog`, `LegacyEvalSurface`, `EvalExecutionMode`, `EvalRunRequest`, `EvalRunReceipt`.
Dependencies: no external libraries beyond TypeScript structural typing; consumed by the other two eval runtime-surface modules.

4. `packages/evals/src/runtime-surface/scenario-source.ts`
Purpose: load and validate MoltZap scenario YAML/data files, reject remaining TS-only deterministic callback shapes, and stage file-backed planned-harness catalogs for the upstream `cc-judge` runner path.
Public surface: `LoadedEvalScenarioDocument`, `EvalScenarioSourceError`, `loadEvalScenarioDocuments(...)`, `stagePlannedHarnessArtifacts(...)`.
Dependencies: `./types.js`, `effect`, `yaml` parser chosen to align with `@moltzap/server-core` and avoid keeping `js-yaml` as a second parser stack long-term.

5. `packages/evals/src/runtime-surface/runner.ts`
Purpose: resolve the default `cc-judge` execution mode versus explicit legacy fallback, and expose one Effect-native entrypoint for running a staged MoltZap eval catalog with shared observability.
Public surface: `EvalRuntimeDependencies`, `EvalRuntimeSurfaceError`, `resolveEvalExecutionMode(...)`, `runEvalCatalog(...)`.
Dependencies: `./types.js`, `./scenario-source.js`, `@moltzap/server-core`, `effect`, supported `cc-judge` planned-harness package surface from `#167/#169`.

## Interfaces

```ts
// packages/server/src/runtime-surface/config.ts
export type RuntimeConfigPath = string & {
  readonly __brand: "RuntimeConfigPath";
};

export type RuntimeEnvironment = "development" | "test" | "production";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLoggingConfig {
  readonly level: RuntimeLogLevel;
  readonly preserveLegacyFields: boolean;
}

export interface RuntimeTracingConfig {
  readonly serviceName: string;
  readonly includeFiberIds: boolean;
  readonly includeRequestContext: boolean;
}

export interface LoadRuntimeConfigInput {
  readonly configPath?: RuntimeConfigPath;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface RuntimeProcessConfig {
  readonly configPath: RuntimeConfigPath;
  readonly configDirectory: string;
  readonly environment: RuntimeEnvironment;
  readonly logging: RuntimeLoggingConfig;
  readonly tracing: RuntimeTracingConfig;
  readonly app: MoltZapAppConfig;
  readonly server: LoadedConfig;
}

export class RuntimeConfigSurfaceError extends Data.TaggedError(
  "RuntimeConfigSurfaceError",
)<{
  readonly cause:
    | {
        readonly _tag: "ConfigFileUnreadable";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "ConfigFileInvalid";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "EnvironmentInvalid";
        readonly key: string;
        readonly message: string;
      }
    | {
        readonly _tag: "DirectoryResolutionFailed";
        readonly path: string;
        readonly message: string;
      };
}> {}

export function loadRuntimeProcessConfig(
  input: LoadRuntimeConfigInput,
): Effect.Effect<RuntimeProcessConfig, RuntimeConfigSurfaceError, never>;
```

Intent: `config.ts` is the one process-boundary decode surface for shared logging/tracing config and for the normalized server bootstrap snapshot.

```ts
// packages/server/src/runtime-surface/logging.ts
export type RuntimeRequestId = string & {
  readonly __brand: "RuntimeRequestId";
};

export type RuntimeSessionId = string & {
  readonly __brand: "RuntimeSessionId";
};

export type RuntimeAgentId = string & {
  readonly __brand: "RuntimeAgentId";
};

export type RuntimeFiberId = string & {
  readonly __brand: "RuntimeFiberId";
};

export type RuntimeSpanName = string & {
  readonly __brand: "RuntimeSpanName";
};

export interface RuntimeLogContext {
  readonly requestId?: RuntimeRequestId;
  readonly sessionId?: RuntimeSessionId;
  readonly agentId?: RuntimeAgentId;
  readonly connectionId?: string;
  readonly workflow?: "rpc" | "session" | "transport" | "eval";
}

export interface RuntimeTraceSpan {
  readonly name: RuntimeSpanName;
  readonly fiberId?: RuntimeFiberId;
  readonly parentFiberId?: RuntimeFiberId;
}

export interface RuntimeObservability {
  readonly logger: Logger;
  readonly config: RuntimeProcessConfig;
  readonly annotate: <A, E, R>(
    context: RuntimeLogContext,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly span: <A, E, R>(
    span: RuntimeTraceSpan,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class RuntimeObservabilityError extends Data.TaggedError(
  "RuntimeObservabilityError",
)<{
  readonly cause:
    | {
        readonly _tag: "LoggerBootstrapFailed";
        readonly message: string;
      }
    | {
        readonly _tag: "FiberSupervisorUnavailable";
        readonly message: string;
      };
}> {}

export function createRuntimeObservability(
  config: RuntimeProcessConfig,
): Effect.Effect<RuntimeObservability, RuntimeObservabilityError, never>;

export function withRuntimeLogContext<A, E, R>(
  context: RuntimeLogContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R>;

export function withRuntimeTraceSpan<A, E, R>(
  span: RuntimeTraceSpan,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R>;
```

Intent: `logging.ts` owns the typed observability contract that server boot, RPC handlers, CLI commands, and eval orchestration all share. `createRuntimeObservability(...)` is the only fallible boundary; once the service exists, `annotate`, `span`, `withRuntimeLogContext(...)`, and `withRuntimeTraceSpan(...)` are total wrappers over typed context rather than a second runtime-validation layer.

```ts
// packages/evals/src/runtime-surface/types.ts
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
```

Intent: `types.ts` makes the local MoltZap-owned surface explicit and keeps generic bundle/report ownership out of `@moltzap/evals`. The declarative scenario contract now mirrors the real MoltZap catalog directly: DM scenarios use `DirectMessage`, group scenarios map `groupBystanders` and `bystanderMessages` into `GroupConversation`, and cross-conversation scenarios map `crossConversationProbe` into `CrossConversation` without hiding those branches behind a generic `conversationMode` plus loosely-related arrays.

```ts
// packages/evals/src/runtime-surface/scenario-source.ts
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
  paths: readonly EvalScenarioDocumentPath[],
): Effect.Effect<
  readonly LoadedEvalScenarioDocument[],
  EvalScenarioSourceError,
  never
>;

export function stagePlannedHarnessArtifacts(input: {
  readonly documents: readonly LoadedEvalScenarioDocument[];
  readonly resultsDirectory: EvalResultsDirectory;
}): Effect.Effect<StagedPlannedHarnessCatalog, EvalScenarioSourceError, never>;
```

Intent: `scenario-source.ts` is the only local module that reads MoltZap eval scenario data and the only allowed place to reject leftover TS callback semantics. It also owns the fan-in from one-or-more scenario YAML files into a single staged harness catalog whose execution input is already frozen in the same `pathOrGlob` terms that `cc-judge` accepts upstream.

```ts
// packages/evals/src/runtime-surface/runner.ts
export interface EvalRuntimeDependencies {
  readonly runtimeConfig: RuntimeProcessConfig;
  readonly observability: RuntimeObservability;
}

export class EvalRuntimeSurfaceError extends Data.TaggedError(
  "EvalRuntimeSurfaceError",
)<{
  readonly cause:
    | {
        readonly _tag: "UnsupportedRuntime";
        readonly runtime: EvalRuntimeKind;
      }
    | {
        readonly _tag: "CcJudgeSurfaceUnavailable";
        readonly message: string;
      }
    | {
        readonly _tag: "LegacyModeRequiresExplicitOptIn";
        readonly surface: LegacyEvalSurface;
      }
    | {
        readonly _tag: "ObservabilityUnavailable";
        readonly message: string;
      };
}> {}

export function resolveEvalExecutionMode(
  input: {
    readonly request: EvalRunRequest;
    readonly stagedHarness: StagedPlannedHarnessCatalog;
  },
): Effect.Effect<EvalExecutionMode, EvalRuntimeSurfaceError, never>;

export function runEvalCatalog(
  deps: EvalRuntimeDependencies,
  request: EvalRunRequest,
): Effect.Effect<
  EvalRunReceipt,
  EvalRuntimeSurfaceError | EvalScenarioSourceError,
  never
>;
```

Intent: `runner.ts` is the only orchestration boundary that knows how MoltZap stages local scenarios into the upstream `cc-judge` path and when legacy mode is still allowed. Mode selection is no longer allowed to invent or infer a plan path; it must consume the staged catalog produced by `stagePlannedHarnessArtifacts(...)`.

## Data flow

- Server boot or eval CLI enters through `loadRuntimeProcessConfig(...)`, which normalizes file-backed config plus env overlays into one `RuntimeProcessConfig`.
- `createRuntimeObservability(...)` constructs the shared logger/tracing service from that config; after that bootstrap step, `withRuntimeLogContext(...)` and `withRuntimeTraceSpan(...)` are total wrappers over typed context and never widen the downstream error channel.
- `loadEvalScenarioDocuments(...)` reads MoltZap-owned YAML/data scenario files into an explicit `DirectMessage | GroupConversation | CrossConversation` union, rejects leftover TS callback fields, and rejects invalid group or cross-conversation document shapes before execution starts.
- `stagePlannedHarnessArtifacts(...)` translates the validated MoltZap scenario documents into a `StagedPlannedHarnessCatalog` with one staged artifact per source document plus a frozen `PlannedHarnessExecutionInput`: single-document runs pass the staged file path through directly, while multi-document runs stage under one directory and hand `cc-judge` a glob-shaped `pathOrGlob` aligned to `run-plans`.
- `resolveEvalExecutionMode(...)` receives both the original request and the staged harness catalog, then chooses `CcJudgeDefault` with the already-built `PlannedHarnessExecutionInput` when the runtime is supported; otherwise it can only return `LegacyLlmJudgeExplicit` when the caller asked for an explicit fallback.
- `runEvalCatalog(...)` runs the staged catalog under the shared observability contract, emits additive structured context, routes default judgment/report ownership to `cc-judge`, and returns the full staged harness catalog in the run receipt for artifact retention and debugging.

```text
process boundary
    |
    v
loadRuntimeProcessConfig(input)
    |-- RuntimeConfigSurfaceError
    v
createRuntimeObservability(config)
    |-- RuntimeObservabilityError
    v
loadEvalScenarioDocuments(paths)
    |-- EvalScenarioSourceError
    v
stagePlannedHarnessArtifacts(documents, resultsDirectory)
    |-- EvalScenarioSourceError
    v
resolveEvalExecutionMode({ request, stagedHarness })
    |-- EvalRuntimeSurfaceError
    v
runEvalCatalog(deps, request)
    |-- EvalRuntimeSurfaceError / EvalScenarioSourceError
    v
cc-judge default run receipt + staged harness catalog retention
```

## Errors

- `loadRuntimeProcessConfig(...)` exposes `RuntimeConfigSurfaceError` so boot-path failures stay typed instead of throwing from config reads or deep env lookups.
- `createRuntimeObservability(...)` exposes `RuntimeObservabilityError` only for logger or fiber-supervisor bootstrap. `annotate`, `span`, `withRuntimeLogContext(...)`, and `withRuntimeTraceSpan(...)` are intentionally total because they operate only on already-typed context and do not perform a second rejectable validation step.
- `loadEvalScenarioDocuments(...)` and `stagePlannedHarnessArtifacts(...)` expose `EvalScenarioSourceError`, including dedicated `ConversationDocumentInvalid` and `DeterministicCallbackNotSupported` branches so the implementation pass cannot silently preserve malformed group/cross-conversation documents or TS callback checks.
- `resolveEvalExecutionMode(...)` and `runEvalCatalog(...)` expose `EvalRuntimeSurfaceError`, including `LegacyModeRequiresExplicitOptIn` so local judge/report paths cannot remain the accidental default.
- `EvalExecutionMode.CcJudgeDefault` carries a `PlannedHarnessExecutionInput` rather than a fake singular plan path, so the implementation must exhaustively handle both `SingleDocument` and `DocumentGlob` staging shapes when multiple scenario documents are present.

## Dependencies

| library | version | license | why this one |
|---|---:|---|---|
| `effect` | `3.21.0` | MIT | Existing runtime substrate across server and evals; this slice freezes typed error and Effect-native orchestration surfaces rather than adding another async/error model. |
| `@effect/platform-node` | `0.106.0` | MIT | Existing Node process/runtime integration already used in server boot paths; implementation reuses it instead of inventing another process-boundary helper layer. |
| `pino` | `9.6.0` | MIT | Existing sink for the shared MoltZap logging shape; this slice standardizes around it and removes `winston` as a parallel runtime logger. |
| `yaml` | `2.8.3` | ISC | Aligns file-backed scenario/config decoding with the parser already present in `@moltzap/server-core`, reducing parser drift during the eval YAML migration. |
| `yargs` | `17.0.0` | MIT | Existing eval CLI parser; the implementation slice can preserve operator-facing flags while changing the default execution mode to `cc-judge`. |

## Traceability

| spec item | slice coverage | module / file |
|---|---|---|
| Goal 2 / AC: shared upstream surfaces for config, logging, and fiber tracing | direct | `packages/server/src/runtime-surface/config.ts`, `packages/server/src/runtime-surface/logging.ts` |
| Goals 3 and 4 / AC: Effect-native boot paths, CLI/runtime logging routed through shared surface, no ad hoc `console.*` default | direct design anchor | `packages/server/src/runtime-surface/config.ts`, `packages/server/src/runtime-surface/logging.ts`, `packages/evals/src/runtime-surface/runner.ts` |
| Goal 5 / AC: remove `winston` from `@moltzap/evals` | direct design anchor | `packages/server/src/runtime-surface/logging.ts`, `packages/evals/src/runtime-surface/runner.ts` |
| Goals 6 and 8 / AC: nanoclaw spike debt cleaned up behind a real runtime abstraction and local generic eval ownership shrinks | direct | `packages/evals/src/runtime-surface/types.ts`, `packages/evals/src/runtime-surface/runner.ts` |
| Goals 7 and 8 / AC: `cc-judge` becomes default and local judge/report surfaces are demoted or removed | direct | `packages/evals/src/runtime-surface/types.ts`, `packages/evals/src/runtime-surface/runner.ts` |
| Goal 11 / AC: MoltZap eval scenarios move from TS catalog callbacks to YAML/data assertions, including current group and cross-conversation behavior | direct | `packages/evals/src/runtime-surface/types.ts`, `packages/evals/src/runtime-surface/scenario-source.ts` |
| Goal 13 / AC: planned-harness YAML stays a second path distinct from the simple prompt/workspace schema and flows through the same `pathOrGlob` ingress that `#167/#169` froze | direct, depends on `#167/#169` | `packages/evals/src/runtime-surface/types.ts`, `packages/evals/src/runtime-surface/scenario-source.ts`, `packages/evals/src/runtime-surface/runner.ts` |
| Goal 17 / AC: no permanent duplicate ownership of generic YAML decode, bundle schema/codec, workspace seeding, or judge/report plumbing | direct | `packages/evals/src/runtime-surface/scenario-source.ts`, `packages/evals/src/runtime-surface/runner.ts` |
| Non-goals 4, 5, 6 and issue ownership constraint: no arena-specific files or harness work in this slice | preserved by scope | all modules above; no `moltzap-arena` paths and no arena-specific interfaces introduced |

## Open questions

1. Q: Should `@moltzap/evals` publish a new package export for `runtime-surface/*` in the first implementation PR, or stay internal until the legacy `./llm-judge`, `./report`, and `./judgment-bundle` subpaths are removed?
Recommended default: keep the runtime-surface internal during the first implementation wave and only publish a new package export once `#172` has actually demoted the legacy surfaces.
Escalation target: `implement-staff` in `#172`.

2. Q: Should `nanoclaw` first-wave support stay behind `LegacyLlmJudgeExplicit`, or must `#172` move it onto `CcJudgeDefault` immediately?
Recommended default: keep `nanoclaw` behind explicit legacy mode in the first implementation wave unless the runtime adapter can emit the same shared-contract receipt shape without relying on `nanoclaw-smoke`.
Escalation target: `implement-staff` in `#172`.

3. Q: Should the eval CLI become a new `cc-judge`-first command surface immediately, or preserve the current command while flipping only the default execution mode?
Recommended default: preserve the current command name and flags for one wave, but make `cc-judge` the default and require an explicit legacy opt-in flag for local judge/report mode.
Escalation target: `implement-staff` in `#172`.
