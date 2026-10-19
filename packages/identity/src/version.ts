/** @file Emitted, live-admission, and retained-history wire compatibility sets. */

import { Context, Effect, Option, Schema } from "effect";

/** Every newly signed artifact carries this version. */
export const WIRE_VERSION = "2026.1006.1";

/** Versions accepted at outer-envelope and authenticated HTTP admission. */
export const LIVE_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** Retained artifacts remain readable until the next protocol reset. */
export const HISTORY_WIRE_VERSIONS = [WIRE_VERSION] as const;

/** A version represented by retained protocol artifacts. */
export type WireVersion = (typeof HISTORY_WIRE_VERSIONS)[number];

/** Optional artifact-decoder configuration; absent services use this binary's sets. */
export class WireVersions extends Context.Tag("@moltzap/identity/WireVersions")<
  WireVersions,
  { readonly live: readonly string[]; readonly history: readonly string[] }
>() {
  /** Retained values share a window throughout nested artifact decoding. */
  static readonly history = Schema.String.pipe(
    Schema.filterEffect((version) =>
      Effect.serviceOption(WireVersions).pipe(
        Effect.map((configuration) =>
          Option.match(configuration, {
            onNone: () =>
              HISTORY_WIRE_VERSIONS.some((item) => item === version),
            onSome: (sets) => sets.history.includes(version),
          }),
        ),
      ),
    ),
  );

  /** Outer admission is independent from retained readability. */
  static readonly live = (version: string) =>
    Effect.serviceOption(WireVersions).pipe(
      Effect.map((configuration) =>
        Option.match(configuration, {
          onNone: () => LIVE_WIRE_VERSIONS.some((item) => item === version),
          onSome: (sets) => sets.live.includes(version),
        }),
      ),
    );
}
