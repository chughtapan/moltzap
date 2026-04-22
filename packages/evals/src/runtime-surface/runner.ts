/**
 * Architecture-only contract for the MoltZap eval runtime entrypoint.
 *
 * Implementers fill this in during the approved runtime cleanup slice.
 */

import { Data, Effect } from "effect";
import type {
  RuntimeObservability,
  RuntimeProcessConfig,
} from "@moltzap/server-core";
import type { EvalScenarioSourceError } from "./scenario-source.js";
import type {
  EvalExecutionMode,
  EvalRunReceipt,
  EvalRunRequest,
  EvalRuntimeKind,
  LegacyEvalSurface,
} from "./types.js";

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
  _request: EvalRunRequest,
): Effect.Effect<EvalExecutionMode, EvalRuntimeSurfaceError, never> {
  throw new Error("not implemented");
}

export function runEvalCatalog(
  _deps: EvalRuntimeDependencies,
  _request: EvalRunRequest,
): Effect.Effect<
  EvalRunReceipt,
  EvalRuntimeSurfaceError | EvalScenarioSourceError,
  never
> {
  throw new Error("not implemented");
}
