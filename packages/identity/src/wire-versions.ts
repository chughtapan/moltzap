/** @file Internal compatibility overrides and public read-only wire operations. */

import { Context, Effect, Option, Schema } from "effect";
import {
  HISTORY_WIRE_VERSIONS,
  LIVE_WIRE_VERSIONS,
  WIRE_VERSION,
} from "./version.js";

/**
 * Injectable release policy lets process tests compose adjacent wire releases.
 * Production compositions use the binary's emitted version and acceptance sets.
 */
export class WireVersions extends Context.Tag("@moltzap/identity/WireVersions")<
  WireVersions,
  {
    readonly emitted?: string;
    readonly live: readonly string[];
    readonly history: readonly string[];
  }
>() {
  /** Signing uses one version throughout a process composition. */
  static readonly emitted = Effect.serviceOption(WireVersions).pipe(
    Effect.map((configuration) =>
      Option.match(configuration, {
        onNone: () => WIRE_VERSION,
        onSome: (sets) => sets.emitted ?? WIRE_VERSION,
      }),
    ),
  );

  /** Retained values share a window throughout nested artifact decoding. */
  static readonly history = Schema.String.pipe(
    Schema.filterEffect((version) =>
      Effect.serviceOption(WireVersions).pipe(
        Effect.map((configuration) =>
          Option.match(configuration, {
            onNone: () =>
              HISTORY_WIRE_VERSIONS.some((item) => item === version),
            onSome: (sets) =>
              HISTORY_WIRE_VERSIONS.some((item) => item === version) ||
              sets.history.includes(version),
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
          onSome: (sets) =>
            sets.live.includes(version) &&
            (sets.emitted !== undefined ||
              LIVE_WIRE_VERSIONS.some((item) => item === version)),
        }),
      ),
    );
}

/** Read-only compatibility operations expose no injectable context tag. */
export const wireVersions = Object.freeze({
  emitted: WireVersions.emitted,
  history: WireVersions.history,
  live: WireVersions.live,
  liveSet: Effect.serviceOption(WireVersions).pipe(
    Effect.map((configuration) =>
      Option.match(configuration, {
        onNone: () => LIVE_WIRE_VERSIONS,
        onSome: (sets) => sets.live,
      }),
    ),
  ),
});
