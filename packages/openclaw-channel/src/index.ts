/**
 * @file Canonical package entry. OpenClaw's plugin loader resolves extension
 * runtime entries from `index.*` at the extension root only, so the built
 * `dist/index.js` must exist; the implementation lives in `openclaw-entry.ts`.
 */
/** Provides the OpenClaw extension entry at the package root. */
// safer-arch-ignore no-public-vendor-type-leak: OpenClaw's loader requires its native plugin type at the extension entry.
// eslint-disable-next-line import-x/no-default-export -- OpenClaw's extension loader resolves the package root default export.
export { default } from "./openclaw-entry.js";
