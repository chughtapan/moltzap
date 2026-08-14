/** @file Whether a module is the process entry point rather than an import. */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_URL_SCHEME = "file:";

/**
 * Whether a module is the process entry point rather than an ordinary import.
 *
 * Both sides are canonicalized because they are not the same kind of path:
 * Node resolves a module's real path before it becomes `import.meta.url`, while
 * `process.argv[1]` is whatever the caller typed. Every executable in this
 * package reaches its module through a symlink in the controller image, where
 * `/opt/moltzap/dist` points at the installed package directory. Comparing the
 * two without canonicalizing makes a directly invoked entry point look like an
 * import, so the process exits successfully having done nothing.
 *
 * `realPath` returns undefined for a path that does not exist, so a missing or
 * deleted `argv[1]` is a plain false rather than a thrown ENOENT.
 *
 * @param moduleUrl URL of the module asking whether it was invoked directly.
 * @param invoked Path the process was started with, if it has one.
 * @returns Whether both locations name the same real file.
 */
export function isEntryModule(moduleUrl: string, invoked?: string): boolean {
  if (invoked === undefined || invoked.length === 0) {
    return false;
  }
  if (!moduleUrl.startsWith(FILE_URL_SCHEME)) {
    return false;
  }
  const entry = realPath(resolve(invoked));
  return entry !== undefined && entry === realPath(fileURLToPath(moduleUrl));
}

function realPath(path: string): string | undefined {
  return existsSync(path) ? realpathSync(path) : undefined;
}
