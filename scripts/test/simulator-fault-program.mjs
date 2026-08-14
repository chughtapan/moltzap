/** @file Deterministic semantic program used by the local Simulator fault qualification. */

import { createConversationId } from "@moltzap/client";
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

function assertText(turn, expected) {
  const [part, ...extra] = turn.content;
  return extra.length === 0 && part?.type === "text" && part.text === expected
    ? Effect.void
    : Effect.fail(
        new Error(
          `expected one text part ${JSON.stringify(expected)}, received ${JSON.stringify(turn.content)}`,
        ),
      );
}

function conversation(endpoint, peer, mintConversationId) {
  return Effect.gen(function* () {
    const conversationId = yield* mintConversationId();
    const address = new ConversationAddress(conversationId, [
      endpoint.participant,
      peer.agent,
    ]);
    const socket = yield* endpoint.socket(address);
    return { address, socket };
  });
}

/**
 * Construct the qualification program with replaceable time and identity
 * seams, leaving the production default on public Client and Effect APIs.
 */
export function makeFaultProgram({
  mintConversationId = createConversationId,
  subscriptionDelay = Effect.sleep(Duration.seconds(1)),
  timeout = DEFAULT_TIMEOUT,
} = {}) {
  const bounded = (label) => withinTimeout(label, timeout);
  return function runFaultExchange(context) {
    return Effect.scoped(
      Effect.gen(function* () {
        const links = yield* LinkController;
        const endpoint = yield* context.network.endpoint(CONTROLLER_NAME);
        const held = yield* conversation(
          endpoint,
          context.agents.held,
          mintConversationId,
        );
        const free = yield* conversation(
          endpoint,
          context.agents.free,
          mintConversationId,
        );

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
            yield* endpoint.start({
              conversationId: held.address.conversationId,
              peers: [context.agents.held.agent.name],
              content: content("held-start"),
            });
            yield* endpoint.start({
              conversationId: free.address.conversationId,
              peers: [context.agents.free.agent.name],
              content: content("free-start"),
            });

            const freeTurn = yield* free.socket
              .receive()
              .pipe(bounded("unfaulted reply"));
            yield* assertText(freeTurn, "free-reply");
            yield* freeTurn.reply(content("free-ack"));

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
          }),
        );

        const heldTurn = yield* Fiber.join(heldReply).pipe(
          bounded("released held reply"),
        );
        yield* assertText(heldTurn, "held-reply");
        yield* heldTurn.reply(content("held-ack"));
        yield* Fiber.join(heldExchange).pipe(bounded("held peer completion"));
      }),
    );
  };
}

/** Production qualification program with bounded waits. */
export const runFaultExchange = makeFaultProgram();
