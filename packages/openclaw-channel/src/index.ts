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
export { default } from "./openclaw-entry.js";
