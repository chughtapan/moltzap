/** @file Removes stale compiled Server modules before the transitional executable rebuilds. */

import { rm } from "node:fs/promises";

await rm(new URL("../dist/", import.meta.url), {
  force: true,
  recursive: true,
  maxRetries: 3,
});
