import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import { Duration, Effect } from "effect";
import { controllerServicesFromEnvironment } from "/opt/moltzap/dist/cluster/controller/services.js";

const AGENT_COUNT = 100;

// Holding the society idle is the measurement. Agents are already running by
// the time execute begins, so the wait exercises whether a cohort this size
// stays up rather than how fast it starts. Nothing is sent, because a hundred
// agents answering would measure the model provider instead of the cluster.
const SOAK = Duration.minutes(10);

// A cold cohort this size waits on node provisioning and an image pull per new
// node, which the two-minute default does not cover.
const STARTUP = Duration.minutes(15);

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

const agents = Object.fromEntries(
  Array.from({ length: AGENT_COUNT }, (_, index) => {
    const name = `agent${String(index + 1).padStart(3, "0")}`;
    return [name, runtime(`You are ${name} in the MoltZap soak society.`)];
  }),
);

export const runSpec = RunSpec.define({
  id: "moltzap.hundred-agent-soak/v1",
  events: [],
  agents,
  cluster: controllerServicesFromEnvironment(),
  execute: () => Effect.sleep(SOAK),
});
