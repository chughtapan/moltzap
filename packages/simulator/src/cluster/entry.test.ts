/* eslint-disable agent-code-guard/no-example-only-tests -- Entry detection is a fixed set of path shapes, not an input domain; each case pins one way a real invocation reaches a module. */

import { assert, effect as test } from "@effect/vitest";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { isEntryModule } from "./entry.js";

test("treats a module reached through a symlinked path as the entry point", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "moltzap-entry-",
      });
      const canonical = join(root, "installed", "main.js");
      yield* fileSystem.makeDirectory(join(root, "installed"));
      yield* fileSystem.writeFileString(canonical, "");
      const linkedDirectory = join(root, "dist");
      yield* fileSystem.symlink(join(root, "installed"), linkedDirectory);
      const invoked = join(linkedDirectory, "main.js");

      // The controller image publishes every executable through a symlinked
      // directory, so the two spellings never match before canonicalization.
      assert.notStrictEqual(
        pathToFileURL(invoked).href,
        pathToFileURL(canonical).href,
      );
      assert.isTrue(isEntryModule(pathToFileURL(canonical).href, invoked));
    }),
  ).pipe(Effect.provide(NodeContext.layer)));

test("rejects a sibling module in the same directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "moltzap-entry-",
      });
      const loaded = join(root, "loaded.js");
      const sibling = join(root, "sibling.js");
      yield* fileSystem.writeFileString(loaded, "");
      yield* fileSystem.writeFileString(sibling, "");

      assert.isFalse(isEntryModule(pathToFileURL(loaded).href, sibling));
    }),
  ).pipe(Effect.provide(NodeContext.layer)));

test("reports no entry point when argv carries no module path", () =>
  Effect.sync(() => {
    const moduleUrl = pathToFileURL("/opt/moltzap/dist/cluster/main.js").href;

    assert.isFalse(isEntryModule(moduleUrl));
    assert.isFalse(isEntryModule(moduleUrl, ""));
  }));

test("reports no entry point for a path that does not exist", () =>
  Effect.sync(() => {
    // A deleted or mistyped argv[1] is a plain negative, not a thrown ENOENT.
    const moduleUrl = pathToFileURL("/opt/moltzap/dist/cluster/main.js").href;

    assert.isFalse(isEntryModule(moduleUrl, "/nonexistent/moltzap/main.js"));
  }));

test("reports no entry point for a module loaded over a non-file scheme", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "moltzap-entry-",
      });
      const invoked = join(root, "main.js");
      yield* fileSystem.writeFileString(invoked, "");

      assert.isFalse(isEntryModule("data:text/javascript,0", invoked));
      assert.isFalse(isEntryModule("https://example.test/main.js", invoked));
    }),
  ).pipe(Effect.provide(NodeContext.layer)));

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore the project default after the entry-shape regressions. */
