/** @file Shared process boundary for incremental integration of existing eval suites. */
import { Command, FileSystem, Path } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";

/** Native grader semantics remain opaque to the shared runner. */
const pilotPlan = Schema.Struct({
  suite: Schema.Literal("moltzap", "propagation", "society-coord"),
  source: Schema.Struct({
    repository: Schema.NonEmptyString,
    revision: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/u)),
    root: Schema.NonEmptyString,
  }),
  operation: Schema.Literal("prepare", "run", "grade", "verify"),
  executable: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  output: Schema.NonEmptyString,
});
/** One explicitly authored invocation, suitable for native Python and TypeScript entrypoints. */
export type PilotPlan = typeof pilotPlan.Type;

/** Decode the reviewed JSON plan at the CLI boundary. */
export const decodePilotPlan = Schema.decodeUnknown(
  Schema.parseJson(pilotPlan),
);

/** A native invocation failed; logs remain in the output bundle. */
class PilotFailed extends Schema.TaggedError<PilotFailed>()("PilotFailed", {
  detail: Schema.String,
}) {}

/** Execute an existing suite without interpreting its PASS/FAIL or degraded vocabulary. */
export function runPilot(plan: PilotPlan) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* validatePilot(plan);
    yield* fs.makeDirectory(plan.output, { recursive: true });
    yield* fs.writeFileString(
      `${plan.output}/plan.json`,
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    const startedAt = new Date().toISOString();
    const runner = yield* runnerProvenance();
    const exitCode = yield* executeNative(plan, startedAt);
    const receipt = {
      suite: plan.suite,
      operation: plan.operation,
      source: plan.source,
      runner,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
    };
    yield* fs.writeFileString(
      `${plan.output}/receipt.json`,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    if (exitCode !== 0) {
      return yield* new PilotFailed({
        detail: `native process exited ${exitCode}; attempt retained`,
      });
    }
    return receipt;
  }).pipe(Effect.withSpan("evals.runPilot"));
}

function validatePilotPaths(plan: PilotPlan) {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    if (!paths.isAbsolute(plan.source.root) || !paths.isAbsolute(plan.output)) {
      return yield* new PilotFailed({
        detail: "source root and output must be absolute",
      });
    }
    const relative = paths.relative(plan.source.root, plan.output);
    if (
      !relative ||
      (!relative.startsWith(`..${paths.sep}`) &&
        relative !== ".." &&
        !paths.isAbsolute(relative))
    ) {
      return yield* new PilotFailed({
        detail: "output must be outside the source checkout",
      });
    }
  });
}

/** Untracked files count as dirt: an unreviewed file can change what a native run does. */
function gitState(root: string) {
  return Effect.gen(function* () {
    const revision = yield* Command.string(
      Command.make("git", "-C", root, "rev-parse", "HEAD"),
    );
    const changes = yield* Command.string(
      Command.make(
        "git",
        "-C",
        root,
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ),
    );
    return { revision: revision.trim(), dirty: changes.trim().length > 0 };
  });
}

function validatePilot(plan: PilotPlan) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* validatePilotPaths(plan);
    if (yield* fs.exists(plan.output)) {
      return yield* new PilotFailed({
        detail: "output already exists; use a new attempt directory",
      });
    }
    const source = yield* gitState(plan.source.root);
    if (source.revision !== plan.source.revision) {
      return yield* new PilotFailed({
        detail: "source revision does not match the plan",
      });
    }
    if (source.dirty) {
      return yield* new PilotFailed({
        detail:
          "source worktree is dirty; commit the candidate before execution",
      });
    }
  });
}

function executeNative(plan: PilotPlan, startedAt: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Command.start(
          Command.make(plan.executable, ...plan.args).pipe(
            Command.workingDirectory(plan.source.root),
            Command.stdout("pipe"),
            Command.stderr("pipe"),
          ),
        );
        const [exitCode] = yield* Effect.all(
          [
            child.exitCode,
            Stream.run(child.stdout, fs.sink(`${plan.output}/stdout`)),
            Stream.run(child.stderr, fs.sink(`${plan.output}/stderr`)),
          ],
          { concurrency: 3 },
        );
        return exitCode;
      }),
    ).pipe(
      Effect.timeout("15 minutes"),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            `${plan.output}/failure.json`,
            `${JSON.stringify({ suite: plan.suite, startedAt, error: String(error) }, null, 2)}\n`,
          );
          return yield* new PilotFailed({
            detail: "native process failed or timed out; attempt retained",
          });
        }),
      ),
    );
  });
}

function runnerProvenance() {
  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const root = yield* paths.fromFileUrl(
      new URL("../../../../", import.meta.url),
    );
    return { repository: "chughtapan/moltzap", ...(yield* gitState(root)) };
  });
}
