/**
 * @file Discards the calling package's `dist/` so each `tsc -b` emits only
 * what current sources produce. A package build runs it from the package
 * directory.
 *
 * Build mode never removes an output whose source is gone: a deleted or
 * renamed module leaves a resolvable `dist/*.js` and `*.d.ts` that project
 * references still typecheck against and the package tarball still ships.
 * Its up-to-date check compares sources against `dist/tsconfig.tsbuildinfo`
 * rather than against each output, so removing the orphans alone still reads
 * as up to date and re-emits nothing. Dropping the whole directory discards
 * the orphans and that build stamp together.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";

rmSync(resolve("dist"), { force: true, recursive: true, maxRetries: 3 });
