/**
 * @file The CLI's exit-code contract and the verbs that read documents
 * and recordings.
 *
 * Exit codes are the CLI's machine-readable half. A script that branches
 * on them is why they key on stable tags, so the tests assert codes
 * rather than prose — prose is allowed to improve.
 */
/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/assertions-in-tests, agent-code-guard/no-example-only-tests -- regression-only suite: each case pins one verb's exit code and one line of its output, which is the CLI's machine-readable contract and a closed set rather than an input domain. The generative gate is the unnamed-tag property below. The per-verb enumeration makes each describe body long, `Effect.runPromise(invoke(...).pipe(Effect.map(assert)))` nests three deep before any assertion, and cases that delegate their assertions to a named helper carry none inline. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Effect, FastCheck as fc, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { stringify as stringifyYaml } from "yaml";
import { STORE_FLAG, main } from "./main.js";
import { EXIT_CODE, exitCodeFor } from "./exit.js";
import {
  makeRecording,
  tamper,
  tempStoreRoot,
} from "../__tests__/recording-fixture.js";
import { specInput } from "../simulator/__tests__/support.js";
import {
  EpisodeOutcome,
  RECORDING_SCHEMA_VERSION,
  describeDrivers,
} from "../simulator/index.js";
import { JsonObject } from "../simulator/run-spec.js";
import { ERROR_TAG, TERMINATION } from "../simulator/__tests__/tags.js";

const CONDITION = "cold-outreach/2";
const OTHER_CONDITION = "cold-outreach/1";
const RUBRIC_FIELD = "expectedBehavior";
const SPEC_MARKER = "seed:";
const ORIGINS_HEADING = "field origins:";
const TS_MARKER = "satisfies RunSpec";
const CLI_NAME = "moltzap-testbed";
const UNKNOWN_VERB = "frobnicate";
const DEFAULT_EVENT_COUNT = 5;

type Fs = FileSystem.FileSystem;

const withFs = <A, E>(
  body: (fs: Fs) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E, never> =>
  Effect.flatMap(FileSystem.FileSystem, body).pipe(
    Effect.provide(NodeContext.layer),
  );

function invoke(...argv: ReadonlyArray<string>) {
  return main(argv);
}

function workspace(): Effect.Effect<string, never, never> {
  return withFs((fs) => fs.makeTempDirectory({ prefix: "cli-" })).pipe(
    Effect.orDie,
  );
}

function writeDocument(
  dir: string,
  name: string,
  body: unknown,
): Effect.Effect<string, never, never> {
  const path = join(dir, name);
  return withFs((fs) => fs.writeFileString(path, stringifyYaml(body))).pipe(
    Effect.orDie,
    Effect.as(path),
  );
}

function writeText(
  dir: string,
  name: string,
  body: string,
): Effect.Effect<string, never, never> {
  const path = join(dir, name);
  return withFs((fs) => fs.writeFileString(path, body)).pipe(
    Effect.orDie,
    Effect.as(path),
  );
}

/**
 * A bundle is a spec with one more section, so this is the same document
 * `run` reads, plus the grade half it never names.
 */
function bundleOf(dir: string, extra: Record<string, unknown> = {}) {
  const spec = Schema.decodeUnknownSync(JsonObject)(
    specInput(dir, {
      condition: {
        label: CONDITION,
        notes: "Tests helpful response to a first-contact DM.",
      },
    }),
  );
  return {
    ...spec,
    grade: {
      grader: "cc-judge",
      config: { [RUBRIC_FIELD]: "respond helpfully" },
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Exit-code mapping
// ---------------------------------------------------------------------------

const CONFIG_TIME_TAGS = [
  ERROR_TAG.runSpecInvalid,
  ERROR_TAG.adapterConfigRejected,
  ERROR_TAG.isolationViolation,
  ERROR_TAG.faultUnsupported,
  ERROR_TAG.unknownDriver,
] as const;

describe("the exit-code mapping", () => {
  it("gives every config-time rejection one code", () => {
    for (const tag of CONFIG_TIME_TAGS) {
      expect(exitCodeFor(tag)).toBe(EXIT_CODE.rejected);
    }
  });

  it("keeps the three reader refusals distinguishable", () => {
    expect(exitCodeFor(ERROR_TAG.recordingUnsealed)).toBe(EXIT_CODE.notSealed);
    expect(exitCodeFor(ERROR_TAG.recordingSchemaMismatch)).toBe(
      EXIT_CODE.schemaMismatch,
    );
    expect(exitCodeFor(ERROR_TAG.recordingInvalid)).toBe(
      EXIT_CODE.invalidRecording,
    );
  });

  it("gives the grading convention its own band", () => {
    expect(exitCodeFor(ERROR_TAG.conditionMismatch)).toBe(
      EXIT_CODE.conditionMismatch,
    );
    expect(exitCodeFor(ERROR_TAG.runNotCompleted)).toBe(
      EXIT_CODE.runNotCompleted,
    );
  });

  it("reports any unnamed tag as unexpected rather than guessing", () =>
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 24 })
          .filter(
            (tag) => !Object.values(ERROR_TAG).some((known) => known === tag),
          ),
        (tag) => exitCodeFor(tag) === EXIT_CODE.unexpected,
      ),
      { numRuns: 50 },
    ));
});

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

describe("spec verbs", () => {
  it("accepts a valid spec", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(dir, "spec.yaml", specInput(dir));
        const output = yield* invoke("spec", "check", path);
        expect(output.code).toBe(EXIT_CODE.ok);
      }),
    ));

  it("rejects an unparseable document at config time", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeText(dir, "broken.yaml", "seed: [unclosed\n");
        const output = yield* invoke("spec", "check", path);
        expect(output.code).toBe(EXIT_CODE.rejected);
      }),
    ));

  it("rejects a document that is not a spec", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(dir, "notaspec.yaml", {
          hello: "world",
        });
        const output = yield* invoke("spec", "check", path);
        expect(output.code).toBe(EXIT_CODE.rejected);
        expect(output.lines[0]).toContain(ERROR_TAG.runSpecInvalid);
      }),
    ));

  it("reports a missing file as a config-time rejection", () =>
    Effect.runPromise(
      invoke("spec", "check", "/definitely/not/here.yaml").pipe(
        Effect.map((output) => {
          expect(output.code).toBe(EXIT_CODE.rejected);
        }),
      ),
    ));

  it("shows per-field origins so defaults are visible as defaults", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(dir, "spec.yaml", specInput(dir));
        const output = yield* invoke("spec", "show", path);
        expect(output.code).toBe(EXIT_CODE.ok);
        expect(output.lines.join("\n")).toContain(ORIGINS_HEADING);
      }),
    ));

  it("emits a TypeScript literal that names the spec type", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(dir, "spec.yaml", specInput(dir));
        const output = yield* invoke("spec", "to-ts", path);
        expect(output.code).toBe(EXIT_CODE.ok);
        expect(output.lines.join("\n")).toContain(TS_MARKER);
      }),
    ));
});

describe("a bundle is a spec the run path reads directly", () => {
  it("materializes a bundle as the spec it is", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(
          dir,
          "cold.bundle.yaml",
          bundleOf(dir),
        );
        const output = yield* invoke("spec", "check", path);
        expect(output.code).toBe(EXIT_CODE.ok);
      }),
    ));

  it("keeps the grade half out of the materialized spec", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(
          dir,
          "cold.bundle.yaml",
          bundleOf(dir),
        );
        const output = yield* invoke("spec", "show", path);
        const shown = output.lines.join("\n");
        expect(shown).toContain(SPEC_MARKER);
        expect(shown).not.toContain(RUBRIC_FIELD);
      }),
    ));

  it("rejects a document that is not a spec at all", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(dir, "nope.yaml", {
          name: "only a name",
        });
        const output = yield* invoke("spec", "check", path);
        expect(output.code).toBe(EXIT_CODE.rejected);
        expect(output.lines[0]).toContain(ERROR_TAG.runSpecInvalid);
      }),
    ));

  it("accepts every bundle the manual prints", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bundles = yield* manualBundles();
        expect(bundles).toHaveLength(MANUAL_BUNDLE_COUNT);
        const dir = yield* workspace();
        yield* Effect.forEach(
          bundles,
          (body, index) =>
            Effect.gen(function* () {
              const path = yield* writeText(
                dir,
                `manual-${String(index)}.bundle.yaml`,
                body,
              );
              const output = yield* invoke("spec", "check", path);
              expect(output.code, body).toBe(EXIT_CODE.ok);
            }),
          { concurrency: 1, discard: true },
        );
      }),
    ));
});

/** The grading chapter, whose bundle examples this suite holds to the tool. */
const GRADING_CHAPTER = fileURLToPath(
  new URL("../../../../docs/simulator/grading.mdx", import.meta.url),
);

const YAML_FENCE = /```yaml\n([\s\S]*?)```/gu;
const GRADE_SECTION = /^grade:/mu;

/** How many bundles the chapter prints; a gate that silently narrows checks nothing. */
const MANUAL_BUNDLE_COUNT = 1;

/**
 * Every fenced YAML block in the manual that carries a `grade:` section,
 * which is what makes a document a bundle rather than a fragment. A
 * printed bundle the tool rejects teaches a shape that does not exist.
 */
function manualBundles(): Effect.Effect<ReadonlyArray<string>, never, never> {
  return withFs((fs) => fs.readFileString(GRADING_CHAPTER)).pipe(
    Effect.orDie,
    Effect.map((chapter) =>
      [...chapter.matchAll(YAML_FENCE)]
        .map((match) => match[1] ?? "")
        .filter((body) => GRADE_SECTION.test(body)),
    ),
  );
}

// ---------------------------------------------------------------------------
// run / rerun
// ---------------------------------------------------------------------------

/**
 * A store root that cannot hold a recording, so the attempt allocation
 * refuses and names the root it tried. Allocation is the first thing a
 * run does with its store and it happens before any container starts,
 * which is what lets these cases read the root a run actually uses
 * without executing one.
 */
function unusableStoreRoot(dir: string): Effect.Effect<string, never, never> {
  return writeText(dir, "not-a-directory", "").pipe(
    Effect.map((path) => join(path, "store")),
  );
}

/**
 * Allocation is the whole contract these cases pin: `run-internal` takes
 * one store object and uses it for the allocation, the manifest, the
 * traces, and the seal, so a run that allocates in the right root cannot
 * seal in a different one.
 */
describe("--store on the verbs that write recordings", () => {
  it("run allocates in the root the flag names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(
          dir,
          "cold.bundle.yaml",
          bundleOf(dir),
        );
        const storeRoot = yield* unusableStoreRoot(dir);
        const output = yield* invoke("run", path, STORE_FLAG, storeRoot);
        expect(output.code).toBe(EXIT_CODE.noRecording);
        expect(output.lines[0]).toContain(storeRoot);
      }),
    ));

  it("run keeps the spec's own root when the flag is absent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const specRoot = yield* unusableStoreRoot(dir);
        const path = yield* writeDocument(
          dir,
          "cold.bundle.yaml",
          bundleOf(specRoot),
        );
        const output = yield* invoke("run", path);
        expect(output.code).toBe(EXIT_CODE.noRecording);
        expect(output.lines[0]).toContain(specRoot);
      }),
    ));

  it("rerun allocates in the root the flag names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const fixture = yield* makeRecording({
          storeRoot: yield* tempStoreRoot(),
        });
        const storeRoot = yield* unusableStoreRoot(dir);
        const output = yield* invoke(
          "rerun",
          fixture.path,
          STORE_FLAG,
          storeRoot,
        );
        expect(output.code).toBe(EXIT_CODE.noRecording);
        expect(output.lines[0]).toContain(storeRoot);
      }),
    ));

  it("refuses a --store whose value is the next flag", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(
          dir,
          "cold.bundle.yaml",
          bundleOf(dir),
        );
        const output = yield* invoke("run", path, STORE_FLAG, "--json");
        expect(output.code).toBe(EXIT_CODE.unexpected);
        expect(output.lines[0]).toContain(STORE_FLAG);
      }),
    ));

  it("refuses a --store with no value at all", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const dir = yield* workspace();
        const path = yield* writeDocument(
          dir,
          "cold.bundle.yaml",
          bundleOf(dir),
        );
        const output = yield* invoke("run", path, STORE_FLAG);
        expect(output.code).toBe(EXIT_CODE.unexpected);
        expect(output.lines[0]).toContain(STORE_FLAG);
      }),
    ));
});

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

type CheckCase = {
  readonly fixture: Omit<Parameters<typeof makeRecording>[0], "storeRoot">;
  readonly flags: ReadonlyArray<string>;
  readonly expected: number;
};

function assertCheck(testCase: CheckCase): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const storeRoot = yield* tempStoreRoot();
    const fixture = yield* makeRecording({ ...testCase.fixture, storeRoot });
    const output = yield* invoke(
      "recording",
      "check",
      fixture.path,
      ...testCase.flags,
    );
    expect(output.code).toBe(testCase.expected);
  });
}

describe("recording verbs", () => {
  it("checks a sealed recording and prints which outcome sealed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const storeRoot = yield* tempStoreRoot();
        const fixture = yield* makeRecording({ storeRoot });
        const output = yield* invoke("recording", "check", fixture.path);
        expect(output.code).toBe(EXIT_CODE.ok);
        expect(output.lines[0]).toContain(TERMINATION.completed);
      }),
    ));

  it("refuses an unsealed recording", () =>
    Effect.runPromise(
      assertCheck({
        fixture: { unsealed: true },
        flags: [],
        expected: EXIT_CODE.notSealed,
      }),
    ));

  it("refuses a sealed recording whose bytes were edited afterwards", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const storeRoot = yield* tempStoreRoot();
        const fixture = yield* makeRecording({ storeRoot });
        yield* tamper(fixture.path, "events.ndjson");
        const output = yield* invoke("recording", "check", fixture.path);
        expect(output.code).toBe(EXIT_CODE.notSealed);
      }),
    ));

  it("refuses a condition mismatch", () =>
    Effect.runPromise(
      assertCheck({
        fixture: { condition: OTHER_CONDITION },
        flags: ["--condition", CONDITION],
        expected: EXIT_CODE.conditionMismatch,
      }),
    ));

  it("refuses a run that did not complete when completion was required", () =>
    Effect.runPromise(
      assertCheck({
        fixture: {
          outcome: new EpisodeOutcome({ termination: TERMINATION.timeout }),
        },
        flags: ["--require-completed"],
        expected: EXIT_CODE.runNotCompleted,
      }),
    ));

  it("accepts a timed-out run when completion was not required", () =>
    Effect.runPromise(
      assertCheck({
        fixture: {
          outcome: new EpisodeOutcome({ termination: TERMINATION.timeout }),
        },
        flags: [],
        expected: EXIT_CODE.ok,
      }),
    ));

  it("shows identity and counts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const storeRoot = yield* tempStoreRoot();
        const fixture = yield* makeRecording({ storeRoot });
        const output = yield* invoke(
          "recording",
          "show",
          fixture.path,
          "--json",
        );
        expect(output.code).toBe(EXIT_CODE.ok);
        const record: unknown = JSON.parse(output.lines[0] ?? "{}");
        expect(record).toMatchObject({ events: DEFAULT_EVENT_COUNT });
      }),
    ));

  it("prints events in logicalSequence order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const storeRoot = yield* tempStoreRoot();
        const fixture = yield* makeRecording({ storeRoot });
        const output = yield* invoke("recording", "events", fixture.path);
        expect(output.code).toBe(EXIT_CODE.ok);
        const sequences = output.lines.map(sequenceOf);
        expect(sequences).toStrictEqual([...sequences].sort((a, b) => a - b));
      }),
    ));
});

function sequenceOf(line: string): number {
  const event: unknown = JSON.parse(line);
  return typeof event === "object" &&
    event !== null &&
    "logicalSequence" in event
    ? Number(event.logicalSequence)
    : -1;
}

// ---------------------------------------------------------------------------
// The tree itself
// ---------------------------------------------------------------------------

describe("the verb tree", () => {
  it("prints usage with no arguments", () =>
    Effect.runPromise(
      invoke().pipe(
        Effect.map((output) => {
          expect(output.code).toBe(EXIT_CODE.ok);
          expect(output.lines[0]).toContain(CLI_NAME);
        }),
      ),
    ));

  it("names the unknown verb rather than failing silently", () =>
    Effect.runPromise(
      invoke(UNKNOWN_VERB).pipe(
        Effect.map((output) => {
          expect(output.code).toBe(EXIT_CODE.unexpected);
          expect(output.lines[0]).toContain(UNKNOWN_VERB);
        }),
      ),
    ));

  it("lists every registered driver with its config schema", () =>
    Effect.runPromise(
      invoke("driver", "check").pipe(
        Effect.map((output) => {
          const listed = output.lines.join("\n");
          expect(output.code).toBe(EXIT_CODE.ok);
          for (const driver of describeDrivers()) {
            expect(listed).toContain(driver.name);
          }
        }),
      ),
    ));

  it("reports the schema version recordings carry", () =>
    Effect.runPromise(
      invoke("lock").pipe(
        Effect.map((output) => {
          expect(output.code).toBe(EXIT_CODE.ok);
          expect(output.lines.join("\n")).toContain(
            String(RECORDING_SCHEMA_VERSION),
          );
        }),
      ),
    ));

  it("never exits non-zero without naming something", () =>
    Effect.runPromise(
      Effect.forEach(
        [["spec"], ["recording"], ["queue"], ["driver"], ["lock", "wat"]],
        (argv) =>
          invoke(...argv).pipe(
            Effect.map((output) => {
              expect(output.lines.join("\n").length).toBeGreaterThan(0);
            }),
          ),
        { concurrency: 1, discard: true },
      ),
    ));
});
