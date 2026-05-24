import { expect, it as vit } from "vitest";
import { live as it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Stream } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("send() delivers message to other agent", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("send-a");
    const regB = yield* H.registerAgent("send-b");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);

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
    const msg = (
      event.params as { message: { parts: Array<{ text: string }> } }
    ).message;
    expect(msg.parts[0]!.text).toBe(H.HELLO_FROM_SERVICE);

    service.close();
    yield* regA.client.close();
    yield* regB.client.close();
  }));

// `TaskConversationArchive` is TM-only (#677). Driving it from the
// owner requires (a) AppsRegister on a custom appId AND (b) a
// `messages/authorize` wire-callback handler — `MoltZapAgentClient`
// doesn't expose `onAppCallback`, only `TestClient`/`MoltZapTMClient`
// do. Re-enable when client-side test infra adds wire-callback
// registration (tracked alongside the 11 server-side TM-only markers
// in chughtapan/moltzap#681).
vit.todo(
  "conversation archive events purge service state and block late sends — needs TM-callback test infra (#681)",
);
