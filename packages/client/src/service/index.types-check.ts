/**
 * @file The process subpath exposes one constant discard Layer and one closed
 * startup error. These canaries keep private daemon configuration and runtime
 * services out of the package boundary.
 */

import type { Layer } from "effect";
import type { MoltZapService } from "./index.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Equal<keyof typeof MoltZapService, "StartupError" | "layer">
>;
type StartupValue = InstanceType<typeof MoltZapService.StartupError>;
type StartupTagIsExact = Expect<
  Equal<StartupValue["_tag"], "MoltZapServiceStartupError">
>;
type StartupPhaseIsExact = Expect<
  Equal<StartupValue["phase"], "configuration" | "storage" | "listener">
>;
type LayerIsExact = Expect<
  Equal<
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
