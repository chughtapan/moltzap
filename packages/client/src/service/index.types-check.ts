/**
 * @file Process factories expose discard Layers and a closed startup error,
 * keeping private daemon services outside the trusted composition boundary.
 */

import type { Layer, Types } from "effect";
import type { MoltZapService } from "./index.js";

type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Types.Equals<
    keyof typeof MoltZapService,
    "StartupError" | "layer" | "withFirewall"
  >
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
