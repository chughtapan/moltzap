/**
 * @file Executes the shipped grading recipe.
 *
 * The recipe is documentation that runs. Printing it in a chapter and
 * testing something else would leave the one script every consumer copies
 * as the least verified artifact in the design, so the chapter points at
 * this file's subject and CI runs it.
 */
/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, agent-code-guard/no-example-only-tests -- regression-only suite: each case spawns the shipped recipe over one fixture and pins which stage refused it, which is the closed set of refusals stage 1 exists to make. Generating recordings is what the fixture already does; generating recipe invocations would generate nothing the enumeration does not cover. Spawning per case makes the describe body long, and each case nests runPromise over pipe over map. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { EXIT_CODE } from "./cli/exit.js";
import {
  makeRecording,
  tempStoreRoot,
  type FixtureOptions,
} from "./__tests__/recording-fixture.js";
import { EpisodeOutcome } from "./simulator/index.js";
import { TERMINATION } from "./simulator/__tests__/tags.js";

const RECIPE = fileURLToPath(
  new URL("../scripts/preflight-and-grade.mjs", import.meta.url),
);
const SIDECAR = "grading-meta.json";
const NO_GRADER_MESSAGE = "no grader was invoked";
const CONDITION = "cold-outreach/2";
/** Each case spawns the CLI in a child process; the default 5s is too tight. */
const RECIPE_TIMEOUT_MS = 60_000;
const OTHER_CONDITION = "cold-outreach/1";

/** A grader stand-in that exits with the code it is told to. */
function graderExiting(code: number): ReadonlyArray<string> {
  return ["--grade", process.execPath, "-e", `process.exit(${String(code)})`];
}

type RecipeResult = {
  readonly status: number;
  readonly stderr: string;
  readonly recording: string;
};

/** Build a fixture, run the recipe over it, and report what came back. */
function runRecipe(
  fixture: Omit<FixtureOptions, "storeRoot">,
  args: ReadonlyArray<string>,
): Effect.Effect<RecipeResult, never, never> {
  return Effect.gen(function* () {
    const storeRoot = yield* tempStoreRoot();
    const built = yield* makeRecording({ ...fixture, storeRoot });
    const result = yield* Effect.sync(() =>
      spawnSync(process.execPath, [RECIPE, built.path, ...args], {
        encoding: "utf8",
      }),
    );
    return {
      status: result.status ?? -1,
      stderr: result.stderr,
      recording: built.path,
    };
  });
}

function sidecarExists(
  recording: string,
): Effect.Effect<boolean, never, never> {
  return Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.exists(join(recording, SIDECAR)),
  ).pipe(Effect.provide(NodeContext.layer), Effect.orDie);
}

describe("the preflight-and-grade recipe", () => {
  it(
    "passes a sealed, completed recording",
    () =>
      Effect.runPromise(
        runRecipe({}, []).pipe(
          Effect.map((result) => {
            expect(result.status).toBe(EXIT_CODE.ok);
          }),
        ),
      ),
    RECIPE_TIMEOUT_MS,
  );

  it(
    "refuses a run that never completed, before any grader starts",
    () =>
      Effect.runPromise(
        runRecipe(
          { outcome: new EpisodeOutcome({ termination: TERMINATION.timeout }) },
          graderExiting(0),
        ).pipe(
          Effect.map((result) => {
            expect(result.status).toBe(EXIT_CODE.runNotCompleted);
            expect(result.stderr).toContain(NO_GRADER_MESSAGE);
          }),
        ),
      ),
    RECIPE_TIMEOUT_MS,
  );

  it(
    "refuses a condition mismatch",
    () =>
      Effect.runPromise(
        runRecipe({ condition: OTHER_CONDITION }, [
          "--condition",
          CONDITION,
        ]).pipe(
          Effect.map((result) => {
            expect(result.status).toBe(EXIT_CODE.conditionMismatch);
          }),
        ),
      ),
    RECIPE_TIMEOUT_MS,
  );

  it(
    "refuses an unsealed recording",
    () =>
      Effect.runPromise(
        runRecipe({ unsealed: true }, []).pipe(
          Effect.map((result) => {
            expect(result.status).toBe(EXIT_CODE.notSealed);
          }),
        ),
      ),
    RECIPE_TIMEOUT_MS,
  );

  it(
    "writes the reproducibility sidecar once a grader has run",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* runRecipe({}, graderExiting(0));
          expect(result.status).toBe(EXIT_CODE.ok);
          expect(yield* sidecarExists(result.recording)).toBe(true);
        }),
      ),
    RECIPE_TIMEOUT_MS,
  );

  it(
    "passes the grader's own verdict through unchanged",
    () =>
      Effect.runPromise(
        Effect.forEach(
          [0, 1, 2],
          (code) =>
            // A graded fail is the grader's own exit, never a convention
            // code: the recipe composes the two stages, it does not re-key
            // the grader.
            runRecipe({}, graderExiting(code)).pipe(
              Effect.map((result) => {
                expect(result.status).toBe(code);
              }),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    RECIPE_TIMEOUT_MS,
  );
});
