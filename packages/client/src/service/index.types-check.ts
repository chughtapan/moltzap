/**
 * @file The process subpath exposes one constant discard Layer and one closed
 * startup error. These canaries keep private daemon configuration and runtime
 * services out of the package boundary.
 */

import type { Layer, Types } from "effect";
import type { MoltZapService } from "./index.js";

type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Types.Equals<keyof typeof MoltZapService, "StartupError" | "layer">
>;
type StartupValue = InstanceType<typeof MoltZapService.StartupError>;
type StartupTagIsExact = Expect<
  Types.Equals<StartupValue["_tag"], "MoltZapServiceStartupError">
>;
type StartupPhaseIsExact = Expect<
  Types.Equals<StartupValue["phase"], "configuration" | "storage" | "listener">
>;
type LayerIsExact = Expect<
  Types.Equals<
    typeof MoltZapService.layer,
    Layer.Layer<never, MoltZapService.StartupError>
  >
>;

/** Compile-time witnesses for the closed Client process boundary. */
export type MoltZapServiceCanaries = [
  NamespaceIsExact,
  StartupTagIsExact,
  StartupPhaseIsExact,
  LayerIsExact,
];
