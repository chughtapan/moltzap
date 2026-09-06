/** @file Real subprocess coverage for pilot provenance and retained failure evidence. */
import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { type PilotPlan, runPilot } from "./pilot.js";

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
      assert.include(
        yield* fs.readFileString(`${plan.output}/receipt.json`),
        '"exitCode": 3',
      );
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
      assert.isFalse(yield* fs.exists(plan.output));
    }).pipe(Effect.provide(NodeContext.layer)),
);
