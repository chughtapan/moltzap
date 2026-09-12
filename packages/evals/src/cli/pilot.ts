/** @file Shared process boundary for incremental integration of existing eval suites. */
import { Command, FileSystem, Path } from "@effect/platform";
import { Cause, Effect, Exit, Schema, Stream } from "effect";

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
    const paths = yield* Path.Path;
    const output = yield* validatePilot(plan);
    yield* fs.makeDirectory(paths.dirname(output), { recursive: true });
    const startedAt = new Date().toISOString();
    return yield* Effect.acquireUseRelease(
      fs.makeDirectory(output).pipe(Effect.as(output)),
      (directory) => executePilot(plan, directory, startedAt),
      (directory, exit) =>
        Exit.isFailure(exit)
          ? fs
              .writeFileString(
                `${directory}/failure.json`,
                `${JSON.stringify({ suite: plan.suite, startedAt, error: Cause.pretty(exit.cause) }, null, 2)}\n`,
              )
              .pipe(Effect.orDie)
          : Effect.void,
    );
  }).pipe(Effect.withSpan("evals.runPilot"));
}

/** The attempt directory is exclusively owned before any evidence is written. */
function executePilot(plan: PilotPlan, output: string, startedAt: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${output}/plan.json`,
      `${JSON.stringify(plan, null, 2)}\n`,
    );
    const runner = yield* runnerProvenance();
    yield* fs.writeFileString(
      `${output}/runner.json`,
      `${JSON.stringify(runner, null, 2)}\n`,
    );
    const exitCode = yield* executeNative(plan, output);
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
      `${output}/receipt.json`,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    if (exitCode !== 0) {
      return yield* new PilotFailed({
        detail: `native process exited ${exitCode}; attempt retained`,
      });
    }
    return receipt;
  });
}

/** Resolve existing ancestors before creating output, including symlink aliases. */
function canonicalOutput(output: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    let ancestor = paths.resolve(output);
    const missing: string[] = [];
    while (!(yield* fs.exists(ancestor))) {
      missing.unshift(paths.basename(ancestor));
      ancestor = paths.dirname(ancestor);
    }
    return paths.join(yield* fs.realPath(ancestor), ...missing);
  });
}

function validatePilotPaths(plan: PilotPlan) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (!paths.isAbsolute(plan.source.root) || !paths.isAbsolute(plan.output)) {
      return yield* new PilotFailed({
        detail: "source root and output must be absolute",
      });
    }
    const source = yield* fs.realPath(plan.source.root);
    const output = yield* canonicalOutput(plan.output);
    const relative = paths.relative(source, output);
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
    const checkout = yield* gitOutput(source, ["rev-parse", "--show-toplevel"]);
    if ((yield* fs.realPath(checkout.trim())) !== source) {
      return yield* new PilotFailed({
        detail: "source root must be the Git checkout root",
      });
    }
    return output;
  });
}

/** Untracked files count as dirt: an unreviewed file can change what a native run does. */
function gitState(root: string) {
  return Effect.gen(function* () {
    const revision = yield* gitOutput(root, ["rev-parse", "HEAD"]);
    const changes = yield* gitOutput(root, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    return { revision: revision.trim(), dirty: changes.trim().length > 0 };
  });
}

/** Empty stdout establishes cleanliness only when Git completed successfully. */
function gitOutput(root: string, args: readonly string[]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Command.start(
        Command.make("git", "-C", root, ...args).pipe(
          Command.stdout("pipe"),
          Command.stderr("pipe"),
        ),
      );
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
        ],
        { concurrency: 3 },
      );
      if (exitCode !== 0) {
        return yield* new PilotFailed({
          detail: `Git ${args[0]} exited ${exitCode}: ${stderr.trim()}`,
        });
      }
      return stdout;
    }),
  );
}

function validatePilot(plan: PilotPlan) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = yield* validatePilotPaths(plan);
    if (yield* fs.exists(output)) {
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
    return output;
  });
}

function executeNative(plan: PilotPlan, output: string) {
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
            Stream.run(child.stdout, fs.sink(`${output}/stdout`)),
            Stream.run(child.stderr, fs.sink(`${output}/stderr`)),
          ],
          { concurrency: 3 },
        );
        return exitCode;
      }),
    ).pipe(Effect.timeout("15 minutes"));
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
