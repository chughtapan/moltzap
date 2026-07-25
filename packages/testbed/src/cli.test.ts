/**
 * @file The CLI's exit-code contract and the verbs that read documents
 * and recordings.
 *
 * Exit codes are the CLI's machine-readable half. A script that branches
 * on them is why they key on stable tags, so the tests assert codes
 * rather than prose — prose is allowed to improve.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertion bodies are extracted to named top-level functions to satisfy the nesting caps; every test delegates to one */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, FastCheck as fc } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { stringify as stringifyYaml } from "yaml";
import { main } from "./cli.js";
import { EXIT_CODE, exitCodeFor } from "./cli-exit.js";
import {
  makeRecording,
  tamper,
  tempStoreRoot,
} from "./__tests__/recording-fixture.js";
import { specInput } from "./simulator/__tests__/support.js";
import { EpisodeOutcome } from "./simulator/index.js";
import { ERROR_TAG, TERMINATION } from "./simulator/__tests__/tags.js";

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
  return {
    ...(specInput(dir, {
      condition: {
        label: CONDITION,
        notes: "Tests helpful response to a first-contact DM.",
      },
    }) as Record<string, unknown>),
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

  it("lists registered drivers with their config schemas", () =>
    Effect.runPromise(
      invoke("driver", "check").pipe(
        Effect.map((output) => {
          expect(output.code).toBe(EXIT_CODE.ok);
          expect(output.lines.join("\n")).toContain("span-name");
        }),
      ),
    ));

  it("reports the pins recordings carry", () =>
    Effect.runPromise(
      invoke("lock").pipe(
        Effect.map((output) => {
          expect(output.code).toBe(EXIT_CODE.ok);
          expect(output.lines.join("\n")).toContain("recordingSchemaVersion");
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
