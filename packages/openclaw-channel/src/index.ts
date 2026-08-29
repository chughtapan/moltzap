/**
 * @file Canonical package entry. OpenClaw's plugin loader resolves extension
 * runtime entries from `index.*` at the extension root only, so the built
 * `dist/index.js` must exist; the implementation lives in `openclaw-entry.ts`.
 */
import plugin from "./openclaw-entry.js";

interface OpenClawLoaderEntry {
  readonly id: string;
}

/** Provides an opaque OpenClaw loader entry without exporting host internals. */
const loaderEntry: OpenClawLoaderEntry = plugin;

// eslint-disable-next-line import-x/no-default-export -- OpenClaw's extension loader resolves the package root default export.
export default loaderEntry;
