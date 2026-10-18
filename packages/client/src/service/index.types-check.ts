/**
 * @file Process factories expose discard Layers and a closed startup error,
 * keeping private daemon services outside the trusted composition boundary.
 */

import type { Layer, Types } from "effect";
import type { HarnessService } from "./index.js";

type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Types.Equals<
    keyof typeof HarnessService,
    "StartupError" | "layer" | "withFirewall"
  >
>;
type StartupValue = InstanceType<typeof HarnessService.StartupError>;
type StartupTagIsExact = Expect<
  Types.Equals<StartupValue["_tag"], "HarnessServiceStartupError">
>;
type StartupPhaseIsExact = Expect<
  Types.Equals<StartupValue["phase"], "configuration" | "storage" | "listener">
>;
type LayerIsExact = Expect<
  Types.Equals<
    typeof HarnessService.layer,
    Layer.Layer<never, HarnessService.StartupError>
  >
>;
type AuditPathIsOptional = Expect<
  Types.Equals<
    HarnessService.FirewallOptions["auditExport"],
    string | undefined
  >
>;

/** Compile-time witnesses for the closed Client process boundary. */
export type HarnessServiceCanaries = [
  NamespaceIsExact,
  StartupTagIsExact,
  StartupPhaseIsExact,
  LayerIsExact,
  AuditPathIsOptional,
];
