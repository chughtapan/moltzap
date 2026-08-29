/** @file Deterministic semantic program used by the local Simulator fault qualification. */

import {
  ConversationAddress,
  LinkController,
} from "@moltzap/simulator/network";
import { Duration, Effect, Fiber, Option } from "effect";

const CONTROLLER_NAME = "controller";
const DEFAULT_TIMEOUT = Duration.minutes(2);

const content = (text) => [{ type: "text", text }];

function withinTimeout(label, timeout) {
  return (effect) =>
    effect.pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new Error(`${label} exceeded ${Duration.format(timeout)}`),
      }),
    );
}

function assertDirectDelivery(delivery, address, expected) {
  const [part, ...extra] = delivery.message.content;
  const matches =
    delivery.message.kind === "direct" &&
    delivery.message.address === address &&
    delivery.message.sender === address &&
    extra.length === 0 &&
    part?.type === "text" &&
    part.text === expected;
  return matches
    ? Effect.void
    : Effect.fail(
        new Error(
          `expected direct delivery from ${JSON.stringify(address)} with one text part ${JSON.stringify(expected)}, received ${JSON.stringify(delivery.message)}`,
        ),
      );
}

function conversation(endpoint, peer) {
  const destination = `agent:${peer.agent.name}`;
  const address = new ConversationAddress(destination, [
    endpoint.participant,
    peer.agent,
  ]);
  return endpoint.socket(address).pipe(
    Effect.map((socket) => ({
      destination,
      socket,
    })),
  );
}

function sendText(endpoint, to, text) {
  return endpoint
    .send({ to, content: content(text) })
    .pipe(
      Effect.flatMap((result) =>
        result === undefined
          ? Effect.void
          : Effect.fail(new Error("addressed send returned a non-void value")),
      ),
    );
}

/**
 * Construct the qualification program with a replaceable timing seam while
 * leaving production behavior on public Client and Effect APIs.
 */
export function makeFaultProgram({
  subscriptionDelay = Effect.sleep(Duration.seconds(1)),
  timeout = DEFAULT_TIMEOUT,
} = {}) {
  const bounded = (label) => withinTimeout(label, timeout);
  return function runFaultExchange(context) {
    return Effect.scoped(
      Effect.gen(function* () {
        const links = yield* LinkController;
        const endpoint = yield* context.network.endpoint(CONTROLLER_NAME);
        const programScope = yield* Effect.scope;
        const held = yield* conversation(endpoint, context.agents.held);
        const free = yield* conversation(endpoint, context.agents.free);

        const heldExchange = yield* context.agents.held.gateway.exchange.pipe(
          bounded("held peer exchange"),
          Effect.forkScoped,
        );
        const freeExchange = yield* context.agents.free.gateway.exchange.pipe(
          bounded("free peer exchange"),
          Effect.forkScoped,
        );

        yield* subscriptionDelay;

        const heldReply = yield* held.socket
          .receive()
          .pipe(bounded("held reply"), Effect.forkScoped);

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* links.hold(context.agents.held.agent, endpoint.participant);
            const heldSend = yield* sendText(
              endpoint,
              held.destination,
              "held-start",
            ).pipe(bounded("held initial send"), Effect.forkIn(programScope));
            yield* sendText(endpoint, free.destination, "free-start");

            const freeDelivery = yield* free.socket
              .receive()
              .pipe(bounded("unfaulted reply"));
            yield* assertDirectDelivery(
              freeDelivery,
              free.destination,
              "free-reply",
            );
            yield* freeDelivery.acknowledge;
            yield* sendText(endpoint, free.destination, "free-ack");

            if (Option.isSome(yield* Fiber.poll(heldReply))) {
              // Joining first preserves an already-completed failure. A
              // successful premature delivery becomes the assertion below.
              yield* Fiber.join(heldReply);
              return yield* Effect.fail(
                new Error(
                  "held delivery arrived before its fault scope closed",
                ),
              );
            }
            yield* Fiber.join(freeExchange).pipe(
              bounded("unfaulted peer completion"),
            );
            return heldSend;
          }),
        ).pipe(
          Effect.flatMap((heldSend) =>
            Fiber.join(heldSend).pipe(bounded("released held send")),
          ),
        );

        const heldDelivery = yield* Fiber.join(heldReply).pipe(
          bounded("released held reply"),
        );
        yield* assertDirectDelivery(
          heldDelivery,
          held.destination,
          "held-reply",
        );
        yield* heldDelivery.acknowledge;
        yield* sendText(endpoint, held.destination, "held-ack");
        yield* Fiber.join(heldExchange).pipe(bounded("held peer completion"));
      }),
    );
  };
}

/** Production qualification program with bounded waits. */
export const runFaultExchange = makeFaultProgram();
