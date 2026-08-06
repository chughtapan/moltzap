import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import { Duration, Effect } from "effect";
import {
  cohortSizeFromEnvironment,
  controllerServicesFromEnvironment,
} from "/opt/moltzap/dist/cluster/controller/services.js";

// One end-to-end run of the whole path: admit a complete roster, bring every
// agent up, hold the society, and give it back. The cohort size is an input
// because the path is the same at two agents and at a hundred, and only the
// time it takes to get there differs.
const AGENTS = cohortSizeFromEnvironment();

// A cold cohort waits on node provisioning and an image pull per new node,
// which the two-minute default does not cover at larger sizes.
const STARTUP = Duration.minutes(15);

// Holding the society idle is the measurement. Agents are already running by
// the time execute begins, so the wait exercises whether a cohort this size
// stays up rather than how fast it starts.
const HOLD = Duration.seconds(30);

const runtime = (identity) =>
  openClawRuntime({
    startupTimeout: STARTUP,
    tools: {
      deny: ["*"],
      elevated: { enabled: false },
      exec: { mode: "deny" },
    },
    sandbox: { mode: "off" },
    workspaceFiles: [{ relativePath: "IDENTITY.md", content: identity }],
  });

const name = (index) => `agent${String(index + 1).padStart(3, "0")}`;

const agents = Object.fromEntries(
  Array.from({ length: AGENTS }, (_, index) => [
    name(index),
    runtime(`You are ${name(index)} in the MoltZap end-to-end society.`),
  ]),
);

export const runSpec = RunSpec.define({
  id: "moltzap.end-to-end/v1",
  events: [],
  agents,
  cluster: controllerServicesFromEnvironment(),
  // Nothing is sent. A hundred agents answering would measure the model
  // provider rather than the cluster, and the complete-roster gate has already
  // passed by the time execute runs.
  execute: () => Effect.sleep(HOLD),
});
