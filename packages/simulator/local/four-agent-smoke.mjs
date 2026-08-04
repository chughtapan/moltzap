import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/runtime";
import { Effect } from "effect";
import { controllerInfrastructureFromEnvironment } from "/opt/moltzap/dist/platform/controller/infrastructure.js";

const runtime = (identity) =>
  openClawRuntime({
    tools: {
      deny: ["*"],
      elevated: { enabled: false },
      exec: { mode: "deny" },
    },
    sandbox: { mode: "off" },
    workspaceFiles: [{ relativePath: "IDENTITY.md", content: identity }],
  });

export const runSpec = RunSpec.define({
  id: "moltzap.local-four-agent-smoke/v1",
  events: [],
  agents: {
    agent01: runtime("You are agent 01 in the local MoltZap smoke society."),
    agent02: runtime("You are agent 02 in the local MoltZap smoke society."),
    agent03: runtime("You are agent 03 in the local MoltZap smoke society."),
    agent04: runtime("You are agent 04 in the local MoltZap smoke society."),
  },
  infrastructure: controllerInfrastructureFromEnvironment(),
  execute: ({ agents, network }) =>
    Effect.gen(function* () {
      const diagnostic = yield* network.endpoint("diagnostic");
      const conversation = yield* diagnostic.open(
        agents.agent01.agent,
        agents.agent02.agent,
        agents.agent03.agent,
        agents.agent04.agent,
      );
      yield* conversation.send("MoltZap local four-agent smoke is ready.");
    }),
});
