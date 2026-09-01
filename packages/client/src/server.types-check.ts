/**
 * @file The process subpath exposes one constant discard Layer and one closed
 * startup error. These canaries keep private daemon configuration and runtime
 * services out of the package boundary.
 */

import type { Layer } from "effect";
import type { MoltZapDaemon } from "./server.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Equal<keyof typeof MoltZapDaemon, "StartupError" | "layer">
>;
type StartupValue = InstanceType<typeof MoltZapDaemon.StartupError>;
type StartupTagIsExact = Expect<
  Equal<StartupValue["_tag"], "MoltZapDaemonStartupError">
>;
type StartupPhaseIsExact = Expect<
  Equal<StartupValue["phase"], "configuration" | "storage" | "listener">
>;
type LayerIsExact = Expect<
  Equal<
    typeof MoltZapDaemon.layer,
    Layer.Layer<never, MoltZapDaemon.StartupError>
  >
>;

/** Compile-time witnesses for the closed Client process boundary. */
export type MoltZapDaemonCanaries = [
  NamespaceIsExact,
  StartupTagIsExact,
  StartupPhaseIsExact,
  LayerIsExact,
];
