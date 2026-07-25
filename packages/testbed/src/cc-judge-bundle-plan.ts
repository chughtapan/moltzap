/**
 * @file The grade half of the bundle projection, in cc-judge's grammar.
 *
 * It is a dist file rather than an export-map entry on purpose: the
 * instrument's export surface carries no consumer's name. A second grader
 * ships its own emitter the same way, over the same `projectBundle`
 * output — that split is what keeps `./grader` generic.
 *
 * Everything grader-shaped lives here. The run half is
 * `projectBundle`, which this consumes without adding to.
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect } from "effect";
import {
  projectBundle,
  type BundleInvalid,
  type ContentVersionConflict,
  type JsonObject,
  type ProjectedBundle,
} from "./grader.js";

/** The recording-backed harness module a plan points at. */
const RECORDING_HARNESS_FILE = "cc-judge-recording-harness.js";

/** A cc-judge plan document, as its loader reads it. */
export type CcJudgePlan = {
  readonly project: string;
  readonly scenarioId: string;
  readonly name: string;
  readonly description: string;
  readonly requirements: JsonObject;
  readonly harness: {
    readonly module: string;
    readonly payload: {
      readonly recording: string;
      readonly contentVersion?: string;
    };
  };
};

/**
 * Resolve the harness module cc-judge should load: the sibling of the
 * `./grader` entry point in this package's dist directory. Resolution
 * goes through the exports map, because that subpath is the one the
 * package publishes; asking for `package.json` is rejected by the same
 * map.
 */
export function resolveRecordingHarness(): string {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve("@moltzap/testbed/grader")),
    RECORDING_HARNESS_FILE,
  );
}

export type EmitPlanOptions = {
  /** The recording directory the plan grades. */
  readonly recording: string;
  /** Override the harness module path; defaults to the resolved sibling. */
  readonly harnessModule?: string;
};

/**
 * Turn a projected bundle into a cc-judge plan. The envelope carries over
 * verbatim and `grade.config` becomes `requirements` untouched — the
 * rubric is the grader's business, and moving it unread is what lets the
 * same bundle serve a grader this file knows nothing about.
 */
export function emitCcJudgePlan(
  projected: ProjectedBundle,
  options: EmitPlanOptions,
): CcJudgePlan {
  const recording = isAbsolute(options.recording)
    ? options.recording
    : resolve(options.recording);
  return {
    project: projected.envelope.project,
    scenarioId: projected.envelope.scenarioId,
    name: projected.envelope.name,
    description: projected.envelope.description,
    requirements: projected.grade.config,
    harness: {
      module: options.harnessModule ?? resolveRecordingHarness(),
      payload:
        projected.contentVersion === undefined
          ? { recording }
          : { recording, contentVersion: projected.contentVersion },
    },
  };
}

/** Project a bundle document and emit its cc-judge plan in one step. */
export function ccJudgePlanFromBundle(
  document: unknown,
  source: { readonly stem: string },
  options: EmitPlanOptions,
): Effect.Effect<CcJudgePlan, BundleInvalid | ContentVersionConflict, never> {
  return projectBundle(document, source).pipe(
    Effect.map((projected) => emitCcJudgePlan(projected, options)),
  );
}
