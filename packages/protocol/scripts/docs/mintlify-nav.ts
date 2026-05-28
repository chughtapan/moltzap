/**
 * @file Writer for the generator-owned Mintlify navigation slice.
 *
 * Emits `docs/modules/_nav.json` containing the Modules group with
 * one entry per generated MDX page. `docs/docs.json` references this
 * file once via `{ "$ref": "./modules/_nav.json" }`; Mintlify resolves
 * the reference at build time.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

interface MintlifyGroup {
  readonly group: string;
  readonly pages: ReadonlyArray<string>;
}

/**
 * Write the Modules navigation group to the given absolute path.
 * Pages are sorted lexically and emitted with stable 2-space indent +
 * LF line endings so the file stays diff-stable across runs.
 */
export const writeModulesNav = (
  absolutePath: string,
  pageSlugs: ReadonlyArray<string>,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const group: MintlifyGroup = {
      group: "Modules",
      pages: [...pageSlugs]
        .map((slug) => `modules/${slug}`)
        .sort((a, b) => a.localeCompare(b)),
    };
    const json = `${JSON.stringify(group, null, 2)}\n`;
    const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.catchAll(() => Effect.void));
    const tmp = `${absolutePath}.tmp.${process.pid}`;
    yield* fs
      .writeFileString(tmp, json)
      .pipe(Effect.catchAll(() => Effect.void));
    yield* fs
      .rename(tmp, absolutePath)
      .pipe(Effect.catchAll(() => Effect.void));
  }).pipe(Effect.withSpan("writeModulesNav"));
