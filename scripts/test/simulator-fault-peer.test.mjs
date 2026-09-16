import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./simulator-workspace-loader.mjs", import.meta.url);
const { Effect, Stream } = await import("effect");
const { runFaultPeer } = await import("./simulator-fault-peer.mjs");

function fixture(sendFailure) {
  const log = [];
  const delivery = (sender, name) => ({
    message: { sender, address: sender },
    acknowledge: Effect.sync(() => log.push(`ack:${name}`)),
  });
  return {
    log,
    endpoint: {
      messages: Stream.fromIterable([
        delivery("agent:bystander", "unrelated"),
        delivery("agent:controller", "request"),
        delivery("agent:controller", "confirmation"),
      ]),
      send: (input) =>
        sendFailure
          ? Effect.fail(sendFailure)
          : Effect.sync(() => {
              log.push(input);
            }),
    },
  };
}

test("fault peer certifies its response and both controller deliveries", async () => {
  const { log, endpoint } = fixture();
  await Effect.runPromise(Effect.scoped(runFaultPeer(endpoint, "held-reply")));
  assert.deepEqual(log, [
    "ack:unrelated",
    { to: "agent:controller", content: [{ type: "text", text: "held-reply" }] },
    "ack:request",
    "ack:confirmation",
  ]);
});

test("failed response does not acknowledge the triggering delivery", async () => {
  const { log, endpoint } = fixture(new Error("certification failed"));
  await assert.rejects(
    Effect.runPromise(Effect.scoped(runFaultPeer(endpoint, "held-reply"))),
    /certification failed/,
  );
  assert.deepEqual(log, ["ack:unrelated"]);
});
