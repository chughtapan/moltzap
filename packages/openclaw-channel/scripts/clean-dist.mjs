/**
 * @file Discard `dist/` so each `tsc -b` emits only what current sources
 * produce.
 *
 * Build mode never removes an output whose source is gone: a deleted or
 * renamed module leaves a resolvable `dist/*.js` and `*.d.ts` that the package
 * tarball still ships. Removing the build stamp with the outputs forces a
 * complete, current emission.
 */
import { rm } from "node:fs/promises";

await rm(new URL("../dist/", import.meta.url), {
  force: true,
  recursive: true,
  maxRetries: 3,
});
