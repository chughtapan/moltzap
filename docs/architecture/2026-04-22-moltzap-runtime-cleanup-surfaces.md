# MoltZap Runtime Cleanup Surfaces

## Summary

This slice freezes two upstream `@moltzap/server-core` surfaces and three `@moltzap/evals` surfaces so the implementation pass can remove Effect-version glue, route runtime logging through one shared observability contract, move MoltZap eval scenarios onto data-backed planned-harness staging, and make `cc-judge` the default execution model without touching arena-owned files. The shape is: `server-core` owns normalized process config plus shared request/session/agent/fiber log context, while `evals` owns only MoltZap-specific scenario documents, staging of planned-harness files for the upstream `cc-judge` ingress slice from `#167/#169`, and an explicit execution-mode boundary that demotes local `llm-judge` / `report` / `judgment-bundle` / `nanoclaw-smoke` paths behind opt-in legacy handling.

## Modules

1. `packages/server/src/runtime-surface/config.ts`
Purpose: normalize file-backed YAML config plus process-env overlays into one typed runtime bootstrap snapshot that downstream server and eval code can share.
Public surface: `RuntimeConfigPath`, `RuntimeEnvironment`, `RuntimeLogLevel`, `RuntimeLoggingConfig`, `RuntimeTracingConfig`, `LoadRuntimeConfigInput`, `RuntimeProcessConfig`, `RuntimeConfigSurfaceError`, `loadRuntimeProcessConfig(...)`.
Dependencies: `../config/effect-config.js`, `../config/loader.js`, `../app/config.js`, `effect`.

2. `packages/server/src/runtime-surface/logging.ts`
Purpose: upstream a shared observability contract around the existing Pino-plus-Effect logger shape, including typed request/session/agent/fiber annotations.
Public surface: `RuntimeRequestId`, `RuntimeSessionId`, `RuntimeAgentId`, `RuntimeFiberId`, `RuntimeSpanName`, `RuntimeLogContext`, `RuntimeTraceSpan`, `RuntimeObservability`, `RuntimeObservabilityError`, `createRuntimeObservability(...)`, `withRuntimeLogContext(...)`, `withRuntimeTraceSpan(...)`.
Dependencies: `../logger.js`, `./config.js`, `effect`.

3. `packages/evals/src/runtime-surface/types.ts`
Purpose: define the MoltZap-owned eval contracts that stay local after generic bundle / judge / report ownership moves to `cc-judge`.
Public surface: `EvalScenarioDocumentPath`, `PlannedHarnessArtifactPath`, `EvalResultsDirectory`, `EvalRunId`, `EvalRuntimeKind`, `EvalConversationMode`, `EvalScenarioAssertion`, `MoltZapEvalScenarioDocument`, `LegacyEvalSurface`, `EvalExecutionMode`, `EvalRunRequest`, `EvalRunReceipt`.
Dependencies: no external libraries beyond TypeScript structural typing; consumed by the other two eval runtime-surface modules.

4. `packages/evals/src/runtime-surface/scenario-source.ts`
Purpose: load and validate MoltZap scenario YAML/data files, reject remaining TS-only deterministic callback shapes, and stage file-backed planned-harness artifacts for the upstream `cc-judge` runner path.
Public surface: `LoadedEvalScenarioDocument`, `StagedPlannedHarnessArtifact`, `EvalScenarioSourceError`, `loadEvalScenarioDocuments(...)`, `stagePlannedHarnessArtifacts(...)`.
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
        readonly _tag: "AnnotationRejected";
        readonly field: string;
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

Intent: `logging.ts` owns the typed observability contract that server boot, RPC handlers, CLI commands, and eval orchestration all share.

```ts
// packages/evals/src/runtime-surface/types.ts
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
```

Intent: `types.ts` makes the local MoltZap-owned surface explicit and keeps generic bundle/report ownership out of `@moltzap/evals`.

```ts
// packages/evals/src/runtime-surface/scenario-source.ts
export interface LoadedEvalScenarioDocument {
  readonly sourcePath: EvalScenarioDocumentPath;
  readonly document: MoltZapEvalScenarioDocument;
}

export interface StagedPlannedHarnessArtifact {
  readonly sourcePath: EvalScenarioDocumentPath;
  readonly plannedHarnessPath: PlannedHarnessArtifactPath;
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
}): Effect.Effect<
  readonly StagedPlannedHarnessArtifact[],
  EvalScenarioSourceError,
  never
>;
```

Intent: `scenario-source.ts` is the only local module that reads MoltZap eval scenario data and the only allowed place to reject leftover TS callback semantics.

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
  request: EvalRunRequest,
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

Intent: `runner.ts` is the only orchestration boundary that knows how MoltZap stages local scenarios into the upstream `cc-judge` path and when legacy mode is still allowed.

## Data flow

- Server boot or eval CLI enters through `loadRuntimeProcessConfig(...)`, which normalizes file-backed config plus env overlays into one `RuntimeProcessConfig`.
- `createRuntimeObservability(...)` constructs the shared logger/tracing service from that config and becomes the only supported source of request/session/agent/fiber annotations.
- `loadEvalScenarioDocuments(...)` reads MoltZap-owned YAML/data scenario files and rejects leftover TS callback fields that block declarative migration.
- `stagePlannedHarnessArtifacts(...)` translates the validated MoltZap scenario documents into staged file-backed planned-harness inputs for the upstream `cc-judge` ingress slice; generic bundle schema and judge/report ownership do not live here.
- `resolveEvalExecutionMode(...)` chooses `CcJudgeDefault` when the runtime is supported and the staged harness path is available; otherwise it can only return `LegacyLlmJudgeExplicit` when the caller asked for an explicit fallback.
- `runEvalCatalog(...)` runs the staged catalog under the shared observability contract, emitting additive structured context and routing default judgment/report ownership to `cc-judge`.

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
resolveEvalExecutionMode(request)
    |-- EvalRuntimeSurfaceError
    v
runEvalCatalog(deps, request)
    |-- EvalRuntimeSurfaceError / EvalScenarioSourceError
    v
cc-judge default run receipt + staged artifact retention
```

## Errors

- `loadRuntimeProcessConfig(...)` exposes `RuntimeConfigSurfaceError` so boot-path failures stay typed instead of throwing from config reads or deep env lookups.
- `createRuntimeObservability(...)`, `withRuntimeLogContext(...)`, and `withRuntimeTraceSpan(...)` expose `RuntimeObservabilityError` via the created service boundary and encode logger bootstrap / annotation rejection / supervisor availability explicitly.
- `loadEvalScenarioDocuments(...)` and `stagePlannedHarnessArtifacts(...)` expose `EvalScenarioSourceError`, including a dedicated `DeterministicCallbackNotSupported` branch so the implementation pass cannot silently preserve TS callback checks.
- `resolveEvalExecutionMode(...)` and `runEvalCatalog(...)` expose `EvalRuntimeSurfaceError`, including `LegacyModeRequiresExplicitOptIn` so local judge/report paths cannot remain the accidental default.
- `EvalExecutionMode` is a closed discriminated union; downstream implementation must exhaustively handle `CcJudgeDefault` and `LegacyLlmJudgeExplicit` instead of drifting back to boolean flags.

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
| Goal 11 / AC: MoltZap eval scenarios move from TS catalog callbacks to YAML/data assertions | direct | `packages/evals/src/runtime-surface/types.ts`, `packages/evals/src/runtime-surface/scenario-source.ts` |
| Goal 13 / AC: planned-harness YAML stays a second path distinct from the simple prompt/workspace schema | direct, depends on `#167/#169` | `packages/evals/src/runtime-surface/scenario-source.ts`, `packages/evals/src/runtime-surface/runner.ts` |
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
