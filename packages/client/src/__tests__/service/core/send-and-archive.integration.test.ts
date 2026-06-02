import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Stream } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("send() delivers message to other agent", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("send-a");
    const regB = yield* H.registerAgent("send-b");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey, regA.agentId);

    const conv = yield* H.createDm(service, regB.agentId);

    // Spec B (#596): `subscribe` returns a Stream backed by `Stream.async`
    // with no historical buffer — a notification that arrives BEFORE
    // materialization is lost forever. Fork the subscriber BEFORE
    // triggering `service.send` so the registry's `register` callback is
    // installed before the server fans the `messages/received` frame to
    // `regB`. Matches the class-sweep pattern applied to openclaw-channel
    // (`waitForReceivedMessage` callers, r1 cleanup) and server-core
    // (`waitForDispatchRelease` etc., r2 cleanup). See
    // `feedback_class_sweep_after_specific_fix`.
    const eventFiber = yield* Effect.fork(
      regB.client.subscribe(H.MessageReceivedNotificationDefinition).pipe(
        Stream.runHead,
        Effect.timeoutFail({
          duration: Duration.millis(H.NOTIFICATION_WAIT_MS),
          onTimeout: () =>
            new Error(
              `timeout waiting for ${H.MessageReceivedNotificationDefinition.name}`,
            ),
        }),
      ),
    );

    yield* service.send(
      conv.task.id,
      conv.conversation!.id,
      H.HELLO_FROM_SERVICE,
    );

    const eventOpt = yield* Fiber.join(eventFiber);
    const event = Option.getOrThrowWith(
      eventOpt,
      () => new Error("notification stream closed before delivery"),
    );
    const part = event.params.message.parts[0]!;
    if (part.type !== "text") {
      throw new Error(`expected text part, got ${part.type}`);
    }
    expect(part.text).toBe(H.HELLO_FROM_SERVICE);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));
