/**
 * @file GKE smoke for subscription credentials: one Anthropic agent through
 * Claude Code on a setup-token, one OpenAI agent through the Codex app-server
 * on a copied ChatGPT login, no API key anywhere.
 *
 * The controller loads this module alone, so it imports only what the
 * controller image ships. Each agent is asked once, from a controller-owned
 * endpoint, to answer through the channel's message tool; the run passes when
 * both answers arrive and each agent was started on its subscription
 * credential alone, so a stray `OPENAI_API_KEY` cannot make the Codex half
 * pass on a path it did not exercise. Submit with `CLAUDE_CODE_OAUTH_TOKEN` and
 * `CODEX_AUTH_JSON` exported and neither API key set.
 */

import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import {
  applicationImageFromEnvironment,
  controllerServicesFromEnvironment,
} from "@moltzap/simulator/controller";
import { Duration, Effect, Fiber, Option, Stream } from "effect";

const CONTROLLER_NAME = "controller";
const REPLY_TIMEOUT = Duration.minutes(5);
const EXPECTED_REPLY = "PROBE-OK";
/** The one credential each agent must have been started on. */
const EXPECTED_CREDENTIAL = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
});

const instructions = [
  "# Instructions",
  "",
  "You are a smoke-test agent. When a message arrives, reply to its sender",
  `through the message tool with exactly the text ${EXPECTED_REPLY} and nothing else.`,
  "Do not use any other tool. Do not reply more than once per message.",
  "",
].join("\n");

const tools = {
  allow: ["message"],
  sandbox: { tools: { allow: ["message"] } },
  elevated: { enabled: false },
  exec: { mode: "full" },
};

function agent(options) {
  return openClawRuntime({
    applicationImage: applicationImageFromEnvironment(),
    startupTimeout: Duration.minutes(5),
    tools,
    workspaceFiles: [{ relativePath: "AGENTS.md", content: instructions }],
    ...options,
  });
}

const agents = {
  claude: agent({
    modelId: "anthropic/claude-opus-4-8",
    agentRuntime: "claude-cli",
  }),
  codex: agent({ modelId: "openai/gpt-5.6-sol" }),
};

function replyText(delivery) {
  const [part, ...extra] = delivery.message.content;
  return extra.length === 0 && part?.type === "text"
    ? part.text.trim()
    : undefined;
}

function awaitReply(endpoint, destination) {
  return endpoint.messages().pipe(
    Stream.filter((delivery) => delivery.message.address === destination),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new Error(`delivery stream ended before ${destination} replied`),
          ),
        onSome: Effect.succeed,
      }),
    ),
    Effect.timeoutFail({
      duration: REPLY_TIMEOUT,
      onTimeout: () =>
        new Error(
          `${destination} sent no reply within ${Duration.format(REPLY_TIMEOUT)}`,
        ),
    }),
  );
}

function probe(endpoint, name, started) {
  const destination = `agent:${started.agent.name}`;
  return Effect.gen(function* () {
    const reply = yield* Effect.fork(awaitReply(endpoint, destination));
    yield* endpoint.send({
      to: destination,
      content: [
        { type: "text", text: `Reply with exactly: ${EXPECTED_REPLY}` },
      ],
    });
    const delivery = yield* Fiber.join(reply);
    yield* delivery.acknowledge;
    return {
      name,
      credentials: started.credentials,
      reply: replyText(delivery),
    };
  });
}

export const runSpec = RunSpec.define({
  id: "moltzap.subscription-smoke/v1",
  events: [],
  agents,
  cluster: controllerServicesFromEnvironment(),
  execute: (context) =>
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* context.network.endpoint(CONTROLLER_NAME);
        yield* Effect.sleep(Duration.seconds(2));
        const results = yield* Effect.all(
          [
            probe(endpoint, "claude", context.agents.claude),
            probe(endpoint, "codex", context.agents.codex),
          ],
          { concurrency: 2 },
        );
        const wrong = results.filter(
          (result) =>
            result.reply !== EXPECTED_REPLY ||
            result.credentials.length !== 1 ||
            result.credentials[0] !== EXPECTED_CREDENTIAL[result.name],
        );
        if (wrong.length > 0) {
          return yield* Effect.fail(
            new Error(
              `unexpected replies or credentials: ${JSON.stringify(wrong)}`,
            ),
          );
        }
        return results;
      }),
    ),
});
