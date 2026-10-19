/** @file Emitted, live-admission, and retained-history wire compatibility sets. */

/** Every newly signed artifact carries this version. */
export const WIRE_VERSION = "2026.1006.1";

/** Versions accepted at outer-envelope and authenticated HTTP admission. */
export const LIVE_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** Retained artifacts remain readable until the next protocol reset. */
export const HISTORY_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** A version represented by retained protocol artifacts. */
export type WireVersion = (typeof HISTORY_WIRE_VERSIONS)[number];
