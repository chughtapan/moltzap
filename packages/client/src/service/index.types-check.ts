/**
 * @file The process subpath exposes one constant discard Layer and one closed
 * startup error. These canaries keep private daemon configuration and runtime
 * services out of the package boundary.
 */

import type { Layer } from "effect";
import type { MoltZapService } from "./index.js";

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- `Probe` stays generic so TypeScript compares the two deferred conditional types by identity. */
/**
 * True only when the two types are identical, so an added optional property
 * or a dropped `readonly` modifier fails the canary.
 */
type Equal<Left, Right> =
  (<Probe>() => Probe extends Left ? 1 : 2) extends <
    Probe,
  >() => Probe extends Right ? 1 : 2
    ? true
    : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters -- Restore repository defaults after the identity helper. */
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
