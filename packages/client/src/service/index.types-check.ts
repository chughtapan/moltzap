/**
 * @file Process factories expose discard Layers and a closed startup error,
 * keeping private daemon services outside the trusted composition boundary.
 */

import type { Layer, Types } from "effect";
import type { Daemon } from "./index.js";

type Expect<Value extends true> = Value;

type NamespaceIsExact = Expect<
  Types.Equals<keyof typeof Daemon, "StartupError" | "layer" | "withFirewall">
>;
type StartupValue = InstanceType<typeof Daemon.StartupError>;
type StartupTagIsExact = Expect<
  Types.Equals<StartupValue["_tag"], "DaemonStartupError">
>;
type StartupPhaseIsExact = Expect<
  Types.Equals<StartupValue["phase"], "configuration" | "storage" | "listener">
>;
type LayerIsExact = Expect<
  Types.Equals<typeof Daemon.layer, Layer.Layer<never, Daemon.StartupError>>
>;
type AuditPathIsOptional = Expect<
  Types.Equals<Daemon.FirewallOptions["auditExport"], string | undefined>
>;

/** Compile-time witnesses for the closed Client process boundary. */
export type DaemonCanaries = [
  NamespaceIsExact,
  StartupTagIsExact,
  StartupPhaseIsExact,
  LayerIsExact,
  AuditPathIsOptional,
];
