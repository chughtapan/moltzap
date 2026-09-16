/** @file Deterministic public-endpoint peer for the simulator fault check. */
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import {
  defineContainerRuntime,
  image,
  routableBridgeEndpoint,
  RuntimeAcquisitionError,
  stoppedBeforeAttach,
} from "@moltzap/simulator/agents";
import { Duration, Effect, Mailbox, Schema } from "effect";

export const FAULT_PEER_PORT = 18791;
export const FAULT_PEER_REPLY_ENV = "MOLTZAP_FAULT_PEER_REPLY";

class FaultPeerConfiguration extends Schema.Class("FaultPeerConfiguration")({
  applicationImage: image,
  reply: Schema.NonEmptyString,
}) {}

/** Respond once to the controller, then wait for its final acknowledgement. */
export function runFaultPeer(endpoint, reply) {
  return Effect.gen(function* () {
    const inbox = yield* Mailbox.fromStream(endpoint.messages);
    const nextControllerMessage = Effect.gen(function* () {
      while (true) {
        const delivery = yield* inbox.take;
        if (
          delivery.message.sender === "agent:controller" &&
          delivery.message.address === "agent:controller"
        ) {
          return delivery;
        }
        yield* delivery.acknowledge;
      }
    });
    const first = yield* nextControllerMessage;
    yield* endpoint.send({
      to: first.message.address,
      content: [{ type: "text", text: reply }],
    });
    yield* first.acknowledge;
    const confirmation = yield* nextControllerMessage;
    yield* confirmation.acknowledge;
  });
}

function bridgeExchange(endpoint) {
  const routed = routableBridgeEndpoint(endpoint);
  const base = `http://${routed.host}:${routed.port}`;
  const request = (value) =>
    HttpClient.HttpClient.pipe(
      Effect.flatMap((client) => client.execute(value)),
    );
  const poll = Effect.suspend(() =>
    request(HttpClientRequest.get(`${base}/result`)).pipe(
      Effect.flatMap((response) => {
        if (response.status === 204) {
          return Effect.sleep(Duration.millis(100)).pipe(Effect.zipRight(poll));
        }
        if (response.status !== 200) {
          return Effect.fail(
            new Error(`Fault peer returned HTTP ${response.status}`),
          );
        }
        return response.json.pipe(
          Effect.flatMap((body) =>
            body?.done === true
              ? Effect.void
              : Effect.fail(
                  new Error(
                    `Fault peer failed: ${body?.error ?? "invalid result"}`,
                  ),
                ),
          ),
        );
      }),
    ),
  );
  return request(HttpClientRequest.post(`${base}/run`)).pipe(
    Effect.flatMap((response) =>
      response.status === 202
        ? poll
        : Effect.fail(
            new Error(`Fault peer trigger returned HTTP ${response.status}`),
          ),
    ),
    Effect.provide(NodeHttpClient.layerUndici),
    Effect.timeout(Duration.minutes(2)),
  );
}

/** Materialize the fixture using the same container and endpoint path as agents. */
export function faultPeerRuntime(applicationImage, reply) {
  return defineContainerRuntime({
    name: "fault-peer",
    configuration: {
      schema: FaultPeerConfiguration,
      value: new FaultPeerConfiguration({ applicationImage, reply }),
    },
    image: applicationImage,
    resources: {
      cpuMillis: 100,
      memoryBytes: 128 * 1024 * 1024,
      ephemeralStorageBytes: 128 * 1024 * 1024,
    },
    render: (input) =>
      Effect.succeed({
        entrypoint: ["node", "/opt/moltzap/agent/entrypoint.mjs"],
        environment: { NODE_ENV: "production", [FAULT_PEER_REPLY_ENV]: reply },
        port: FAULT_PEER_PORT,
        files: [],
        attach: (endpoint, stopped) =>
          Effect.succeed({
            exchange: bridgeExchange(endpoint).pipe(
              Effect.raceFirst(
                stoppedBeforeAttach(stopped, (detail) =>
                  RuntimeAcquisitionError.make({
                    runtime: "fault-peer",
                    agent: input.agentName,
                    detail,
                  }),
                ),
              ),
            ),
          }),
      }),
  });
}
