/** @file Emitted, live-admission, and retained-history wire compatibility sets. */

/**
 * Every newly signed artifact carries this reset wire value. The .2 value is
 * distinct from the published pre-reset 2026.1019.1 package, whose wire is
 * 2026.1006.1; package publication never determines wire compatibility.
 */
export const WIRE_VERSION = "2026.1019.2";

/**
 * The emitted version, then at most one adjacent version. Holding two lets
 * adjacent releases interoperate across a bump in either direction: the
 * release before a bump lists the successor it does not yet emit, and the
 * bumping release lists the predecessor it no longer emits.
 */
type LiveWindow =
  | readonly [emitted: typeof WIRE_VERSION]
  | readonly [emitted: typeof WIRE_VERSION, adjacent: string];

/** A window whose adjacent version repeats the emitted one is not a window. */
type DistinctWindow<Window extends LiveWindow> = Window extends readonly [
  string,
  typeof WIRE_VERSION,
]
  ? never
  : Window;

const liveWindow = [WIRE_VERSION] as const satisfies LiveWindow;

/**
 * Versions accepted at outer-envelope and authenticated HTTP admission by the
 * Registry, the Router, and the daemon.
 */
export const LIVE_WIRE_VERSIONS: DistinctWindow<typeof liveWindow> = liveWindow;

/** Versions that left the live window since the last protocol reset. */
const RETIRED_WIRE_VERSIONS = [] as const;

/** Retained artifacts remain readable until the next protocol reset. */
export const HISTORY_WIRE_VERSIONS = [
  ...LIVE_WIRE_VERSIONS,
  ...RETIRED_WIRE_VERSIONS,
] as const;

/** A version represented by retained protocol artifacts. */
export type WireVersion = (typeof HISTORY_WIRE_VERSIONS)[number];
