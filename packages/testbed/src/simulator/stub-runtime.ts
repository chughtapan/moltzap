/**
 * @file StubRuntime: a scripted external agent process speaking the real
 * WS wire protocol — the hermetic-CI and demo tier, and the `Runtime`
 * contract's reference implementation. Always bannered as scripted; a
 * StubRuntime society is never presented as agent cognition. Behavior
 * scripts are instrument fixtures (not scenario logic) and live behind
 * demo/test entry points.
 */
import { Schema } from "effect";
import type { SimulatorRuntime } from "./run-config.js";

/** One scripted behavior step; the closed v0 vocabulary. */
export const StubStep = Schema.Union(
  Schema.TaggedStruct("send", {
    to: Schema.String.annotations({ description: "Recipient agent name" }),
    content: Schema.String.annotations({
      description: "Message content to send",
    }),
    afterMs: Schema.optionalWith(
      Schema.Int.annotations({ description: "Wall delay before sending" }),
      { default: () => 0 },
    ),
  }),
  Schema.TaggedStruct("replyOnMatch", {
    pattern: Schema.String.annotations({
      description: "Substring matched against inbound messages",
    }),
    content: Schema.String.annotations({ description: "Reply content" }),
  }),
  Schema.TaggedStruct("signalDone", {
    afterMs: Schema.Int.annotations({
      description: "Wall delay before emitting the done signal",
    }),
  }),
  Schema.TaggedStruct("exit", {
    exitCode: Schema.Int.annotations({
      description: "Process exit code (crash-path fixtures)",
    }),
    afterMs: Schema.Int.annotations({
      description: "Wall delay before exiting",
    }),
  }),
).annotations({ description: "Scripted StubRuntime behavior step" });
export type StubStep = typeof StubStep.Type;

/** A named, registered behavior script referenced from `StubSlotConfig.script`. */
export class StubScript extends Schema.Class<StubScript>("StubScript")({
  name: Schema.NonEmptyString.annotations({
    description: "Registered script name",
  }),
  steps: Schema.Array(StubStep).annotations({
    description: "Steps executed in order; matchers stay armed",
  }),
}) {}

export type StubOptions = {
  readonly script: StubScript;
};

/**
 * Create a StubRuntime adapter. Spawns an external scripted process that
 * authenticates over the real WS protocol; no model keys, no external
 * network.
 */
export function makeStubRuntime(_options: StubOptions): SimulatorRuntime {
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- interface stub; the signature is the contract, the body is downstream
  throw new Error("not implemented");
}
