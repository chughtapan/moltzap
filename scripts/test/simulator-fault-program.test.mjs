import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./simulator-workspace-loader.mjs", import.meta.url);

const { Duration, Deferred, Effect } = await import("effect");
const { LinkController } = await import("@moltzap/simulator/network");
const { makeFaultProgram } = await import("./simulator-fault-program.mjs");

const conversations = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const participants = Object.freeze({
  controller: Object.freeze({ name: "controller", id: "controller-id" }),
  held: Object.freeze({ name: "held", id: "held-id" }),
  free: Object.freeze({ name: "free", id: "free-id" }),
});

function text(value) {
  return [{ type: "text", text: value }];
}

function executeProgram(options = {}) {
  return Effect.gen(function* () {
    const log = [];
    const freeReply = yield* Deferred.make();
    const heldReply = yield* Deferred.make();
    const freeAcknowledged = yield* Deferred.make();
    const heldAcknowledged = yield* Deferred.make();
    let conversationIndex = 0;

    const freeTurn = {
      content: text(options.freeContent ?? "free-reply"),
      reply: (reply) =>
        Effect.sync(() => {
          log.push(`reply:${reply[0]?.text}`);
        }).pipe(Effect.zipRight(Deferred.succeed(freeAcknowledged, undefined))),
    };
    const heldTurn = {
      content: text("held-reply"),
      reply: (reply) =>
        Effect.sync(() => {
          log.push(`reply:${reply[0]?.text}`);
        }).pipe(Effect.zipRight(Deferred.succeed(heldAcknowledged, undefined))),
    };
    const endpoint = {
      participant: participants.controller,
      socket: (address) => {
        const isHeld = address.participants.some(
          ({ name }) => name === participants.held.name,
        );
        return Effect.succeed({
          receive: () =>
            isHeld
              ? (options.heldReceive ?? Deferred.await(heldReply)).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      log.push("receive:held");
                    }),
                  ),
                )
              : Deferred.await(freeReply).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      log.push("receive:free");
                    }),
                  ),
                ),
        });
      },
      start: (input) =>
        Effect.sync(() => {
          log.push(`start:${input.peers[0]}:${input.content[0]?.text}`);
        }).pipe(
          Effect.zipRight(
            input.peers[0] === participants.free.name
              ? Deferred.succeed(freeReply, freeTurn)
              : Effect.void,
          ),
        ),
    };
    const links = {
      hold: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            log.push("hold:held->controller");
          }),
          () =>
            Effect.sync(() => {
              log.push("release:held->controller");
            }).pipe(Effect.zipRight(Deferred.succeed(heldReply, heldTurn))),
        ),
    };
    const context = {
      network: { endpoint: () => Effect.succeed(endpoint) },
      agents: {
        held: {
          agent: participants.held,
          gateway: {
            exchange: Deferred.await(heldAcknowledged).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  log.push("exchange:held:complete");
                }),
              ),
            ),
          },
        },
        free: {
          agent: participants.free,
          gateway: {
            exchange: Deferred.await(freeAcknowledged).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  log.push("exchange:free:complete");
                }),
              ),
            ),
          },
        },
      },
    };
    const program = makeFaultProgram({
      mintConversationId: () =>
        Effect.sync(() => conversations[conversationIndex++]),
      subscriptionDelay: Effect.void,
      timeout: Duration.seconds(2),
    });

    yield* program(context).pipe(Effect.provideService(LinkController, links));
    return log;
  });
}

test("keeps the unfaulted exchange live until the scoped hold clears", async () => {
  assert.deepEqual(await Effect.runPromise(executeProgram()), [
    "hold:held->controller",
    "start:held:held-start",
    "start:free:free-start",
    "receive:free",
    "reply:free-ack",
    "exchange:free:complete",
    "release:held->controller",
    "receive:held",
    "reply:held-ack",
    "exchange:held:complete",
  ]);
});

test("propagates a completed held-receive failure", async () => {
  await assert.rejects(
    Effect.runPromise(
      executeProgram({ heldReceive: Effect.fail(new Error("held failed")) }),
    ),
    /held failed/,
  );
});

test("fails through the Effect channel when a peer changes reply bytes", async () => {
  await assert.rejects(
    Effect.runPromise(executeProgram({ freeContent: "wrong reply" })),
    /expected one text part "free-reply"/,
  );
});
