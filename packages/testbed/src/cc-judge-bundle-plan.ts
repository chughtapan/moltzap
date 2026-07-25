/**
 * @file The grade half of a bundle, in cc-judge's grammar.
 *
 * It is a dist file rather than an export-map entry on purpose: the
 * instrument's export surface carries no consumer's name. A second grader
 * ships its own emitter the same way, over the same bundle document —
 * that split is what keeps `./grader` generic.
 *
 * A bundle is a spec with one more section, so this reads the document
 * itself. It decodes the two keys a plan needs and ignores every other
 * spec key, which is what lets the run path and the grade path read one
 * file without either knowing the other's shape.
 */
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { JsonObject } from "./grader.js";
import { RunSpecInvalid } from "./simulator/errors.js";

/** The recording-backed harness module a plan points at. */
const RECORDING_HARNESS_FILE = "cc-judge-recording-harness.js";

/** Plans with no project of their own land under the instrument's own key. */
const DEFAULT_PROJECT = "simulator";

/**
 * The keys a grader plan reads. Every other spec key is the run's
 * business, so this decodes a narrow view rather than re-stating the spec
 * schema a second time.
 */
const BundleGradeHalf = Schema.Struct({
  condition: Schema.optional(
    Schema.Struct({
      label: Schema.NonEmptyString,
      notes: Schema.optional(Schema.String),
    }),
  ),
  grade: Schema.Struct({
    grader: Schema.NonEmptyString.annotations({
      description: "Grader reference: module path or well-known binary",
    }),
    config: JsonObject.annotations({
      description: "Grader-owned configuration; never interpreted here",
    }),
  }),
});
type BundleGradeHalf = typeof BundleGradeHalf.Type;

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
      readonly condition?: string;
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
  /** The bundle file's stem, which names the scenario. */
  readonly stem: string;
  /** Override the harness module path; defaults to the resolved sibling. */
  readonly harnessModule?: string;
};

/**
 * Turn a bundle's grade half into a cc-judge plan. `grade.config` becomes
 * `requirements` untouched — the rubric is the grader's business, and
 * moving it unread is what lets one bundle serve a grader this file knows
 * nothing about. A bundle that declares no condition is named by its file
 * stem, the same default that names the scenario.
 */
export function emitCcJudgePlan(
  bundle: BundleGradeHalf,
  options: EmitPlanOptions,
): CcJudgePlan {
  const recording = isAbsolute(options.recording)
    ? options.recording
    : resolve(options.recording);
  const label = bundle.condition?.label;
  const name = label ?? options.stem;
  return {
    project: DEFAULT_PROJECT,
    scenarioId: options.stem,
    name,
    description: bundle.condition?.notes ?? name,
    requirements: bundle.grade.config,
    harness: {
      module: options.harnessModule ?? resolveRecordingHarness(),
      payload:
        label === undefined ? { recording } : { recording, condition: label },
    },
  };
}

/**
 * Decode a bundle document and emit its cc-judge plan. A document that
 * carries no `grade:` is not a bundle, and that is a config-time
 * rejection for the same reason a malformed spec is: nothing ran, and the
 * fix is in the document.
 */
export function ccJudgePlanFromBundle(
  document: unknown,
  options: EmitPlanOptions,
): Effect.Effect<CcJudgePlan, RunSpecInvalid, never> {
  return Schema.decodeUnknown(BundleGradeHalf)(document).pipe(
    Effect.mapError(
      (cause) =>
        new RunSpecInvalid({
          issues: [{ path: ["grade"], message: cause.message }],
          message: `The document does not carry a gradeable bundle shape (${cause.message}). A bundle is a spec plus a grade section naming a grader and its config.`,
        }),
    ),
    Effect.map((bundle) => emitCcJudgePlan(bundle, options)),
  );
}
