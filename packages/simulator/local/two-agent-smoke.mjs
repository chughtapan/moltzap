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
  id: "moltzap.local-two-agent-smoke/v1",
  events: [],
  agents: {
    alice: runtime("You are Alice in the local MoltZap smoke society."),
    bob: runtime("You are Bob in the local MoltZap smoke society."),
  },
  infrastructure: controllerInfrastructureFromEnvironment(),
  execute: ({ agents, network }) =>
    Effect.gen(function* () {
      const diagnostic = yield* network.endpoint("diagnostic");
      const conversation = yield* diagnostic.open(
        agents.alice.agent,
        agents.bob.agent,
      );
      yield* conversation.send("MoltZap local two-agent smoke is ready.");
    }),
});
