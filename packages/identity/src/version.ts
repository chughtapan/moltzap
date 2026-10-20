/** @file Emitted, live-admission, and retained-history wire compatibility sets. */

/**
 * Every newly signed artifact carries this reset wire value. It differs from
 * every earlier reset's value (2026.1006.1, 2026.1019.2), so a peer from before
 * the latest reset fails live admission with `version-mismatch` rather than
 * exchanging renamed protocol labels; package publication never determines
 * wire compatibility.
 */
export const WIRE_VERSION = "2026.1020.2";

/** Versions accepted at outer-envelope and authenticated HTTP admission. */
export const LIVE_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** Retained artifacts remain readable until the next protocol reset. */
export const HISTORY_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** A version represented by retained protocol artifacts. */
export type WireVersion = (typeof HISTORY_WIRE_VERSIONS)[number];
