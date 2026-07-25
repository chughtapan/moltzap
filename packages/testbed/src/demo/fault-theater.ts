/**
 * @file The demo's spec fixture: two scripted participants, one severed
 * link that heals, and a done-signal that ends the episode.
 *
 * It is written as a literal rather than shipped as a YAML asset so the
 * schema keeps it honest: a field that changes shape breaks the build
 * here instead of failing at the demo's first invocation, which is the
 * one invocation a new reader makes.
 *
 * The fault window is the whole point. `severAtMs` lands after the
 * opening message and reverts before the done-signal fires, so the
 * recording holds a `fault.applied` / `fault.reverted` pair around live
 * traffic — the smallest thing that shows why the log is worth reading.
 */
import { Schema } from "effect";
import { RunSpec } from "../simulator/index.js";

/**
 * Pinned digest of the demo's server image. The demo is the one entry
 * point that must run with no arguments, so it carries a pin rather than
 * asking for one; a spec authored for real use names its own.
 */
export const DEMO_SERVER_IMAGE_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const SEVER_AT_MS = 3_000;
const HEAL_AT_MS = 8_000;
const INACTIVITY_TIMEOUT_MS = 60_000;

/** Build the demo spec against a store root. */
export function demoSpec(storeRoot: string): RunSpec {
  return Schema.decodeUnknownSync(RunSpec)({
    seed: 1,
    agents: [
      {
        name: "asker",
        runtime: { _tag: "stub", config: { script: "demo-asker" } },
        runsIn: "host",
        role: "standard",
      },
      {
        name: "responder",
        runtime: { _tag: "stub", config: { script: "demo-responder" } },
        runsIn: "host",
        role: "standard",
      },
    ],
    server: { imageDigest: DEMO_SERVER_IMAGE_DIGEST },
    world: {
      faults: [
        {
          fault: { _tag: "sever", target: "responder" },
          applyAtMs: SEVER_AT_MS,
          revertAtMs: HEAL_AT_MS,
        },
      ],
    },
    episode: {
      task: {
        principal: "operator",
        to: "asker",
        content: "Check whether the responder is reachable and report back.",
      },
      termination: {
        inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
        onAgentCrash: "halt",
        doneSignal: {
          name: "span-name",
          config: { name: "moltzap.message.delivered", minCount: 2 },
        },
      },
    },
    recording: { storeRoot },
  });
}
