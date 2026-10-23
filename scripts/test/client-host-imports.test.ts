/** @file Packed-root fixtures prove the host gate rejects daemon-only dependencies. */
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { verifyHostImportGraph } from "./client-host-imports.ts";

for (const module of [
  "dist/transport/messaging/address.js",
  "dist/harness/protocol/schemas.js",
]) {
  await test(`the host gate rejects a root reaching ${module}`, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "client-host-gate-",
          });
          yield* fs.makeDirectory(dirname(join(root, module)), {
            recursive: true,
          });
          yield* fs.writeFileString(join(root, module), "export {};\n");
          yield* fs.writeFileString(
            join(root, "dist/index.js"),
            `import "./${module.slice(5)}";\n`,
          );
          const failure = yield* verifyHostImportGraph(
            root,
            "dist/index.js",
          ).pipe(Effect.flip);
          assert.equal(
            failure.message,
            `client root entry loads ${module}, which is not a host module`,
          );
        }),
      ).pipe(Effect.provide(NodeContext.layer)),
    ));
}

await test("the host gate accepts a root reaching reviewed host values", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "client-host-gate-",
        });
        yield* fs.makeDirectory(join(root, "dist/harness/protocol"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          join(root, "dist/harness/protocol/names.js"),
          "export {};\n",
        );
        yield* fs.writeFileString(
          join(root, "dist/index.js"),
          'import "./harness/protocol/names.js";\n',
        );
        yield* verifyHostImportGraph(root, "dist/index.js");
      }),
    ).pipe(Effect.provide(NodeContext.layer)),
  ));
