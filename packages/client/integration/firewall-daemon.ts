/**
 * @file A real daemon process with a firewall installed, for the integration
 * traces that run collective operations under one.
 *
 * The daemon runs `Daemon.withFirewall` with one deterministic code policy in
 * the mode `SHARNESS_TEST_FIREWALL_MODE` names, so a trace decides each check
 * by the text it sends: the policy blocks an incoming text that carries
 * `[in]` and an outgoing text that carries `[out]`, and asks the agent to
 * respond to an incoming text that carries `[guide]`. Every other
 * `SHARNESS_*` setting is read as `sharnessd` reads it.
 */

import { NodeRuntime } from "@effect/platform-node";
import { Config, ConfigProvider, Effect, Layer } from "effect";
import { Daemon, type MessageMiddleware } from "../src/service/index.js";

/** The marker an incoming text carries to be withheld. */
const INCOMING_HOLD = "[in]";
/** The marker an outgoing text carries to be refused. */
const OUTGOING_HOLD = "[out]";
/** The marker an incoming text carries to draw guidance. */
const GUIDE = "[guide]";

const markers: MessageMiddleware = {
  id: "integration-markers",
  revision: "markers-v1",
  rules: [
    {
      id: "marked",
      kind: "norm",
      guidance: "Respond to the marked message.",
      feedback: { nextAction: "revise", text: "Remove the marked text." },
    },
  ],
  check: ({ event }) =>
    Effect.succeed({
      findings: [
        {
          ruleId: "marked",
          outcome: event.message.text.includes(
            event.direction === "incoming" ? INCOMING_HOLD : OUTGOING_HOLD,
          )
            ? "block"
            : "pass",
        },
      ],
      expectations:
        event.direction === "incoming" && event.message.text.includes(GUIDE)
          ? [
              {
                ruleId: "marked",
                expectation: "required",
                subjects: [event.message.id],
              },
            ]
          : [],
    }),
};

const program = Config.literal(
  "guidance",
  "enforcement",
)("SHARNESS_TEST_FIREWALL_MODE").pipe(
  Effect.flatMap((mode) =>
    Layer.launch(
      Daemon.withFirewall({
        mode,
        incoming: [markers],
        outgoing: [markers],
        settings: {
          timeoutMilliseconds: 10_000,
          middlewareTimeoutMilliseconds: 8_000,
          maximumInputBytes: 1_000_000,
          maximumResultBytes: 100_000,
        },
        facts: [],
        codeDigest: "0".repeat(64),
      }),
    ),
  ),
);

program.pipe(
  Effect.withConfigProvider(ConfigProvider.fromEnv()),
  NodeRuntime.runMain,
);
