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
  id: "moltzap.local-ten-agent-smoke/v1",
  events: [],
  agents: {
    agent01: runtime("You are agent 01 in the local MoltZap smoke society."),
    agent02: runtime("You are agent 02 in the local MoltZap smoke society."),
    agent03: runtime("You are agent 03 in the local MoltZap smoke society."),
    agent04: runtime("You are agent 04 in the local MoltZap smoke society."),
    agent05: runtime("You are agent 05 in the local MoltZap smoke society."),
    agent06: runtime("You are agent 06 in the local MoltZap smoke society."),
    agent07: runtime("You are agent 07 in the local MoltZap smoke society."),
    agent08: runtime("You are agent 08 in the local MoltZap smoke society."),
    agent09: runtime("You are agent 09 in the local MoltZap smoke society."),
    agent10: runtime("You are agent 10 in the local MoltZap smoke society."),
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
        agents.agent05.agent,
        agents.agent06.agent,
        agents.agent07.agent,
        agents.agent08.agent,
        agents.agent09.agent,
        agents.agent10.agent,
      );
      yield* conversation.send("MoltZap local ten-agent smoke is ready.");
    }),
});
