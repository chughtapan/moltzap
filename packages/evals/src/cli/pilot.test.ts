/** @file Real subprocess coverage for pilot provenance and retained failure evidence. */
import { Command, FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Either, Stream } from "effect";
import { decodePilotPlan, type PilotPlan, runPilot } from "./pilot.js";

function fixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = `${root}/source`;
    yield* fs.makeDirectory(source);
    yield* Command.exitCode(
      Command.make("git", "init", "-q", "-b", "main", source),
    );
    yield* fs.writeFileString(`${source}/input`, "fixture");
    yield* Command.exitCode(Command.make("git", "-C", source, "add", "input"));
    yield* Command.exitCode(
      Command.make(
        "git",
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture",
      ),
    );
    const revision = yield* Command.string(
      Command.make("git", "-C", source, "rev-parse", "HEAD"),
    );
    const plan: PilotPlan = {
      suite: "propagation",
      source: {
        root: source,
        repository: "example/fixture",
        revision: revision.trim(),
      },
      operation: "grade",
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({verdict:'FAIL',reason:'native semantics'}))",
      ],
      output: `${root}/attempt`,
    };
    return { fs, plan };
  });
}

/** Drain both output streams so CLI diagnostics cannot block a subprocess exit. */
function cliExit(cli: string, planFile: string) {
  return Effect.gen(function* () {
    const child = yield* Command.start(
      Command.make(
        process.execPath,
        "--import",
        "tsx",
        cli,
        "--plan",
        planFile,
      ).pipe(Command.stdout("pipe"), Command.stderr("pipe")),
    );
    const [exitCode] = yield* Effect.all(
      [
        child.exitCode,
        Stream.runDrain(child.stdout),
        Stream.runDrain(child.stderr),
      ],
      { concurrency: 3 },
    );
    return exitCode;
  });
}

// @agent-code-guard/regression-only: these subprocess regressions pin path rejection, source cleanliness, and retained native failure evidence.
it.scopedLive("rejects outputs below a filesystem-root source", () =>
  Effect.gen(function* () {
    const { fs, plan } = yield* fixture();
    const paths = yield* Path.Path;
    const result = yield* Effect.either(
      runPilot({
        ...plan,
        source: { ...plan.source, root: paths.parse(plan.source.root).root },
      }),
    );
    Either.match(result, {
      onLeft: (error) => {
        assert.propertyVal(
          error,
          "detail",
          "output must be outside the source checkout",
        );
      },
      onRight: () => assert.fail("output inside the source was accepted"),
    });
    assert.isFalse(yield* fs.exists(plan.output));
  }).pipe(Effect.provide(NodeContext.layer)),
);

it.scopedLive(
  "retains native failure grades without equating them to execution failure",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const receipt = yield* runPilot(plan);
      assert.strictEqual(receipt.exitCode, 0);
      assert.include(
        yield* fs.readFileString(`${plan.output}/stdout`),
        '"verdict":"FAIL"',
      );
      const repeated = yield* Effect.either(runPilot(plan));
      assert.isTrue(
        Either.match(repeated, { onLeft: () => true, onRight: () => false }),
      );
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "retains logs and the receipt when the native process exits nonzero",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const result = yield* Effect.either(
        runPilot({
          ...plan,
          args: ["-e", "console.error('native error');process.exitCode=3"],
        }),
      );
      assert.isTrue(
        Either.match(result, { onLeft: () => true, onRight: () => false }),
      );
      assert.include(
        yield* fs.readFileString(`${plan.output}/stderr`),
        "native error",
      );
      const receipt: unknown = JSON.parse(
        yield* fs.readFileString(`${plan.output}/receipt.json`),
      );
      assert.propertyVal(receipt, "exitCode", 3);
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "rejects dirty source and incorrect provenance before creating an attempt",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const mismatched = yield* Effect.either(
        runPilot({
          ...plan,
          source: { ...plan.source, revision: "a".repeat(40) },
        }),
      );
      assert.isTrue(
        Either.match(mismatched, { onLeft: () => true, onRight: () => false }),
      );
      yield* fs.writeFileString(`${plan.source.root}/input`, "changed");
      const dirty = yield* Effect.either(runPilot(plan));
      assert.isTrue(
        Either.match(dirty, { onLeft: () => true, onRight: () => false }),
      );
      yield* fs.writeFileString(
        `${plan.source.root}/.git/index`,
        "corrupt index",
      );
      const corrupt = yield* Effect.flip(runPilot(plan));
      assert.propertyVal(corrupt, "_tag", "PilotFailed");
      assert.include(JSON.stringify(corrupt), "Git status exited 128");
      assert.isFalse(yield* fs.exists(plan.output));
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "rejects an output alias into the source without changing source files",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const alias = `${plan.output}-alias`;
      yield* fs.symlink(plan.source.root, alias);
      const result = yield* Effect.either(
        runPilot({ ...plan, output: `${alias}/attempt` }),
      );
      Either.match(result, {
        onLeft: (error) => {
          assert.propertyVal(
            error,
            "detail",
            "output must be outside the source checkout",
          );
        },
        onRight: () => assert.fail("output alias into source was accepted"),
      });
      assert.isFalse(yield* fs.exists(`${plan.source.root}/attempt`));
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive("only one concurrent invocation owns an attempt directory", () =>
  Effect.gen(function* () {
    const { fs, plan } = yield* fixture();
    const results = yield* Effect.all(
      [
        Effect.either(runPilot(plan)),
        Effect.either(runPilot(plan)),
        Effect.either(runPilot(plan)),
        Effect.either(runPilot(plan)),
        Effect.either(runPilot(plan)),
        Effect.either(runPilot(plan)),
      ],
      { concurrency: 6 },
    );
    const winners = results.filter((result) =>
      Either.match(result, { onLeft: () => false, onRight: () => true }),
    );
    assert.lengthOf(winners, 1);
    const receipt: unknown = JSON.parse(
      yield* fs.readFileString(`${plan.output}/receipt.json`),
    );
    assert.propertyVal(receipt, "exitCode", 0);
    assert.include(
      yield* fs.readFileString(`${plan.output}/stdout`),
      '"verdict":"FAIL"',
    );
  }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "decodes authored plans and reports invalid JSON and schema fields",
  () =>
    Effect.gen(function* () {
      const { plan } = yield* fixture();
      assert.deepEqual(yield* decodePilotPlan(JSON.stringify(plan)), plan);
      const invalidJson = yield* Effect.flip(decodePilotPlan("{"));
      assert.include(invalidJson.message, "JSON");
      const invalidSuite = yield* Effect.flip(
        decodePilotPlan(JSON.stringify({ ...plan, suite: "unknown" })),
      );
      assert.include(invalidSuite.message, "suite");
      const invalidOperation = yield* Effect.flip(
        decodePilotPlan(JSON.stringify({ ...plan, operation: "unknown" })),
      );
      assert.include(invalidOperation.message, "operation");
      const invalidRevision = yield* Effect.flip(
        decodePilotPlan(
          JSON.stringify({
            ...plan,
            source: { ...plan.source, revision: "main" },
          }),
        ),
      );
      assert.include(invalidRevision.message, "revision");
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "rejects relative and equal output paths before starting a native process",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const relativeOutput = yield* Effect.flip(
        runPilot({ ...plan, output: "attempt" }),
      );
      assert.propertyVal(
        relativeOutput,
        "detail",
        "source root and output must be absolute",
      );
      const relativeSource = yield* Effect.flip(
        runPilot({ ...plan, source: { ...plan.source, root: "source" } }),
      );
      assert.propertyVal(
        relativeSource,
        "detail",
        "source root and output must be absolute",
      );
      const equalOutput = yield* Effect.flip(
        runPilot({ ...plan, output: plan.source.root }),
      );
      assert.propertyVal(
        equalOutput,
        "detail",
        "output must be outside the source checkout",
      );
      yield* fs.makeDirectory(`${plan.source.root}/subdirectory`);
      const subdirectory = yield* Effect.flip(
        runPilot({
          ...plan,
          source: { ...plan.source, root: `${plan.source.root}/subdirectory` },
          output: `${plan.source.root}/attempt`,
        }),
      );
      assert.propertyVal(
        subdirectory,
        "detail",
        "source root must be the Git checkout root",
      );
      assert.isFalse(yield* fs.exists(`${plan.source.root}/attempt`));
      assert.isFalse(yield* fs.exists(plan.output));
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "untracked source files prevent execution without creating an attempt",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      yield* fs.writeFileString(
        `${plan.source.root}/unreviewed`,
        "untracked input",
      );
      const failure = yield* Effect.flip(runPilot(plan));
      assert.propertyVal(
        failure,
        "detail",
        "source worktree is dirty; commit the candidate before execution",
      );
      assert.isFalse(yield* fs.exists(plan.output));
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "a missing executable leaves failure evidence and no success receipt",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const failedPlan = {
        ...plan,
        executable: `${plan.source.root}/missing-executable`,
      };
      const paths = yield* Path.Path;
      const runnerRoot = yield* paths.fromFileUrl(
        new URL("../../../../", import.meta.url),
      );
      const runnerRevision = yield* Command.string(
        Command.make("git", "-C", runnerRoot, "rev-parse", "HEAD"),
      );
      const failure = yield* Effect.flip(runPilot(failedPlan));
      assert.propertyVal(failure, "_tag", "SystemError");
      assert.propertyVal(failure, "reason", "NotFound");
      const retained: unknown = JSON.parse(
        yield* fs.readFileString(`${plan.output}/failure.json`),
      );
      assert.propertyVal(retained, "suite", plan.suite);
      assert.include(
        yield* fs.readFileString(`${plan.output}/failure.json`),
        "missing-executable",
      );
      assert.isFalse(yield* fs.exists(`${plan.output}/receipt.json`));
      const runner: unknown = JSON.parse(
        yield* fs.readFileString(`${plan.output}/runner.json`),
      );
      assert.propertyVal(runner, "repository", "chughtapan/moltzap");
      assert.propertyVal(runner, "revision", runnerRevision.trim());
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(`${plan.output}/plan.json`)),
        failedPlan,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "retains source and runner provenance while passing cwd and arguments literally",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const paths = yield* Path.Path;
      const literal = "spaces; $(not-a-command) 'quoted'";
      const authored = {
        ...plan,
        args: [
          "-e",
          "console.log(JSON.stringify({cwd:process.cwd(),argument:process.argv[1]}))",
          literal,
        ],
      };
      const receipt = yield* runPilot(authored);
      const native: unknown = JSON.parse(
        yield* fs.readFileString(`${plan.output}/stdout`),
      );
      assert.propertyVal(native, "cwd", plan.source.root);
      assert.propertyVal(native, "argument", literal);
      assert.deepEqual(receipt.source, plan.source);
      const runnerRoot = yield* paths.fromFileUrl(
        new URL("../../../../", import.meta.url),
      );
      const revision = yield* Command.string(
        Command.make("git", "-C", runnerRoot, "rev-parse", "HEAD"),
      );
      const dirty = yield* Command.string(
        Command.make(
          "git",
          "-C",
          runnerRoot,
          "status",
          "--porcelain",
          "--untracked-files=normal",
        ),
      );
      assert.deepEqual(receipt.runner, {
        repository: "chughtapan/moltzap",
        revision: revision.trim(),
        dirty: dirty.trim().length > 0,
      });
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(`${plan.output}/plan.json`)),
        authored,
      );
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(`${plan.output}/receipt.json`)),
        receipt,
      );
    }).pipe(Effect.provide(NodeContext.layer)),
);
it.scopedLive(
  "the CLI executes a reviewed plan and returns nonzero for invalid input",
  () =>
    Effect.gen(function* () {
      const { fs, plan } = yield* fixture();
      const paths = yield* Path.Path;
      const cli = yield* paths.fromFileUrl(
        new URL("./pilot-cli.ts", import.meta.url),
      );
      const planFile = `${plan.output}-plan.json`;
      yield* fs.writeFileString(planFile, JSON.stringify(plan));
      const success = yield* cliExit(cli, planFile);
      assert.strictEqual(success, 0);
      const receipt: unknown = JSON.parse(
        yield* fs.readFileString(`${plan.output}/receipt.json`),
      );
      assert.propertyVal(receipt, "suite", plan.suite);
      assert.propertyVal(receipt, "exitCode", 0);
      yield* fs.writeFileString(planFile, "{");
      const invalid = yield* cliExit(cli, planFile);
      assert.notStrictEqual(invalid, 0);
    }).pipe(Effect.provide(NodeContext.layer)),
  20_000,
);
