/** @file Emitted, live-admission, and retained-history wire compatibility sets. */

/**
 * Every newly signed artifact carries this reset wire value. The .2 value is
 * distinct from the published pre-reset 2026.1019.1 package, whose wire is
 * 2026.1006.1; package publication never determines wire compatibility.
 */
export const WIRE_VERSION = "2026.1019.2";

/** Versions accepted at outer-envelope and authenticated HTTP admission. */
export const LIVE_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** Retained artifacts remain readable until the next protocol reset. */
export const HISTORY_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** A version represented by retained protocol artifacts. */
export type WireVersion = (typeof HISTORY_WIRE_VERSIONS)[number];
