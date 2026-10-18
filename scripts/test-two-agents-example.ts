/**
 * @file Runs `examples/two-agents` against the packed Identity, Router, and
 * Client tarballs, the way a new user runs it after installing from npm.
 *
 * The consumer project takes the example's own third-party dependencies, so a
 * dependency the example needs but does not declare fails here. The gate
 * passes when the example prints bob receiving alice's message.
 */
import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  readJsonFile,
  requireCondition,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const exampleRoot = join(workspaceRoot, "examples", "two-agents");
const workspacePackageRoots = {
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
};
const exampleManifest = Schema.Struct({
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
});

/** The line the example prints once bob's endpoint delivers the message. */
const receivedLine = "bob received: from agent:alice: Hi Bob, this is Alice.";

runGate("moltzap-two-agents-example-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives } = yield* packWorkspaceClosure(
      workspacePackageRoots,
      temporaryRoot,
      new Set(Object.keys(workspacePackageRoots)),
    );
    const manifest = yield* readJsonFile(
      join(exampleRoot, "package.json"),
      exampleManifest,
    );
    const moltzapDependencies = Object.keys(manifest.dependencies).filter(
      (name) => name.startsWith("@moltzap/"),
    );
    yield* requireCondition(
      moltzapDependencies.length === Object.keys(archives).length &&
        moltzapDependencies.every((name) => name in archives),
      `the example must depend on exactly ${Object.keys(archives).join(", ")}`,
    );
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "moltzap-two-agents-example",
      archives,
      dependencies: Object.fromEntries(
        Object.entries(manifest.dependencies).filter(
          ([name]) => !(name in archives),
        ),
      ),
    });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.copyFile(
      join(exampleRoot, "two-agents.ts"),
      join(consumerRoot, "two-agents.ts"),
    );
    const output = yield* runCommand(process.execPath, ["two-agents.ts"], {
      cwd: consumerRoot,
      env: { NODE_PATH: "" },
    });
    yield* requireCondition(
      output.split("\n").includes(receivedLine),
      `the example did not print "${receivedLine}":\n${output}`,
    );
    return `${output}two-agents example passed`;
  }),
);
