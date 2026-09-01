import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./simulator-workspace-loader.mjs", import.meta.url);

const { Duration, Deferred, Effect, Stream } = await import("effect");
const { LinkController } = await import("@moltzap/simulator/network");
const { makeFaultProgram } = await import("./simulator-fault-program.mjs");

const participants = Object.freeze({
  controller: Object.freeze({ name: "controller", id: "controller-id" }),
  held: Object.freeze({ name: "held", id: "held-id" }),
  free: Object.freeze({ name: "free", id: "free-id" }),
});

function text(value) {
  return [{ type: "text", text: value }];
}

function assertBefore(log, earlier, later) {
  assert.ok(
    log.indexOf(earlier) < log.indexOf(later),
    `expected ${JSON.stringify(earlier)} before ${JSON.stringify(later)}`,
  );
}

function executeProgram(options = {}) {
  return Effect.gen(function* () {
    const log = [];
    const freeReply = yield* Deferred.make();
    const heldReply = yield* Deferred.make();
    const freeAcknowledged = yield* Deferred.make();
    const heldAcknowledged = yield* Deferred.make();
    const delivery = (peer, postId, replyText) => ({
      message: {
        kind: "direct",
        postId,
        address: `agent:${peer}`,
        sender: `agent:${peer}`,
        content: text(replyText),
      },
      acknowledge: Effect.sync(() => {
        log.push(`acknowledge:${peer}`);
      }),
    });
    const freeDelivery = delivery(
      participants.free.name,
      "pst_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      options.freeContent ?? "free-reply",
    );
    const heldDelivery = delivery(
      participants.held.name,
      "pst_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "held-reply",
    );
    const endpoint = {
      participant: participants.controller,
      messages: () =>
        Stream.merge(
          Stream.fromEffect(Deferred.await(freeReply)),
          Stream.fromEffect(options.heldReceive ?? Deferred.await(heldReply)),
        ),
      send: (input) => {
        const firstPart = input.content[0];
        const messageText = firstPart?.type === "text" ? firstPart.text : "";
        const freeAddress = `agent:${participants.free.name}`;
        const heldAddress = `agent:${participants.held.name}`;
        let completion = Effect.void;
        if (input.to === freeAddress && messageText === "free-start") {
          completion = Deferred.succeed(freeReply, freeDelivery);
        } else if (input.to === freeAddress && messageText === "free-ack") {
          completion = Deferred.succeed(freeAcknowledged, undefined);
        } else if (input.to === heldAddress && messageText === "held-ack") {
          completion = Deferred.succeed(heldAcknowledged, undefined);
        }
        return Effect.sync(() => {
          log.push(`send:${input.to}:${messageText}`);
        }).pipe(Effect.zipRight(completion), Effect.asVoid);
      },
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
            }).pipe(Effect.zipRight(Deferred.succeed(heldReply, heldDelivery))),
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
      subscriptionDelay: Effect.void,
      timeout: Duration.seconds(2),
    });

    yield* program(context).pipe(Effect.provideService(LinkController, links));
    return log;
  });
}

test("keeps the unfaulted exchange live until the scoped hold clears", async () => {
  const log = await Effect.runPromise(executeProgram());
  const expectedEvents = [
    "hold:held->controller",
    "send:agent:held:held-start",
    "send:agent:free:free-start",
    "acknowledge:free",
    "send:agent:free:free-ack",
    "exchange:free:complete",
    "release:held->controller",
    "acknowledge:held",
    "send:agent:held:held-ack",
    "exchange:held:complete",
  ];

  assert.deepEqual(log.toSorted(), expectedEvents.toSorted());
  assertBefore(log, "hold:held->controller", "send:agent:held:held-start");
  assertBefore(log, "hold:held->controller", "send:agent:free:free-start");
  assertBefore(log, "send:agent:held:held-start", "release:held->controller");
  assertBefore(log, "send:agent:free:free-start", "acknowledge:free");
  assertBefore(log, "acknowledge:free", "send:agent:free:free-ack");
  assertBefore(log, "send:agent:free:free-ack", "exchange:free:complete");
  assertBefore(log, "exchange:free:complete", "release:held->controller");
  assertBefore(log, "release:held->controller", "acknowledge:held");
  assertBefore(log, "acknowledge:held", "send:agent:held:held-ack");
  assertBefore(log, "send:agent:held:held-ack", "exchange:held:complete");
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
    /with one text part "free-reply"/,
  );
});
