/**
 * @file Package entry for tools that import the extension by package name.
 *
 * OpenClaw discovers `dist/plugin.js` through package metadata. `dist/index.js`
 * gives other package consumers a stable default export without exposing
 * OpenClaw-specific types.
 */
import plugin from "./plugin.js";

interface OpenClawLoaderEntry {
  readonly id: string;
}

/** Provides an opaque OpenClaw loader entry without exporting host internals. */
const loaderEntry: OpenClawLoaderEntry = plugin;

// eslint-disable-next-line import-x/no-default-export -- OpenClaw's extension loader resolves the package root default export.
export default loaderEntry;
