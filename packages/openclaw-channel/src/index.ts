/**
 * @file Canonical package entry. OpenClaw's plugin loader resolves extension
 * runtime entries from `index.*` at the extension root only, so the built
 * `dist/index.js` must exist; the implementation lives in `openclaw-entry.ts`.
 */
export {
  createMoltzapChannelPlugin,
  moltzapChannelPlugin,
  type MoltzapChannelPlugin,
} from "./openclaw-entry.js";
/** Re-exports the public API from `./openclaw-entry.js`. */
// eslint-disable-next-line import-x/no-default-export -- OpenClaw's extension loader resolves the package root default export.
export { default } from "./openclaw-entry.js";
