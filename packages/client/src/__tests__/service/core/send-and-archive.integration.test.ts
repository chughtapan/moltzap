import { expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Duration, Effect, Either, Option, Stream } from "effect";
import * as H from "../../support/index.js";

H.setupServiceIntegration();

it("send() delivers message to other agent", () =>
  Effect.gen(function* () {
    const regA = yield* H.registerAgent("send-a");
    const regB = yield* H.registerAgent("send-b");

    yield* regB.client.connect();
    const service = yield* H.connectService(regA.apiKey);

    const conv = yield* service.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regB.agentId }],
    });

    yield* service.send(conv.conversation.id, H.HELLO_FROM_SERVICE);

    // Spec B (#596): subscribe via Stream API; runHead + timeoutFail is
    // the one-shot pattern for tests that previously used
    // `client.waitForNotification(def, timeoutMs)`.
    const eventOpt = yield* regB.client
      .subscribe(H.MessageReceivedNotificationDefinition)
      .pipe(
        Stream.runHead,
        Effect.timeoutFail({
          duration: Duration.millis(H.NOTIFICATION_WAIT_MS),
          onTimeout: () =>
            new Error(
              `timeout waiting for ${H.MessageReceivedNotificationDefinition.name}`,
            ),
        }),
      );
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

it("conversation archive events purge service state and block late sends", () =>
  Effect.gen(function* () {
    const regOwner = yield* H.registerAgent("archive-owner");
    const regReceiver = yield* H.registerAgent("archive-receiver");

    yield* regOwner.client.connect();
    const service = yield* H.connectService(regReceiver.apiKey);

    const conv = yield* regOwner.client.sendRpc(H.ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: regReceiver.agentId }],
    });
    const convId = conv.conversation.id;

    yield* H.sendAndSettle(regOwner.client, convId, "before archive");
    expect(service.getHistory(convId)).toHaveLength(1);

    const archivedEvents: unknown[] = [];
    service.on("conversationArchived", (data) => archivedEvents.push(data));

    yield* regOwner.client.sendRpc(H.ConversationsArchive, {
      conversationId: convId,
    });
    yield* Effect.sleep("500 millis");

    expect(archivedEvents).toHaveLength(1);
    expect(service.isConversationArchived(convId)).toBe(true);
    expect(service.getConversation(convId)).toBeUndefined();
    expect(service.getHistory(convId)).toEqual([]);

    const lateSend = yield* Effect.either(
      service.send(convId, "after archive"),
    );
    Either.match(lateSend, {
      onLeft: (error) =>
        expect(error).toMatchObject({
          code: H.ConversationArchivedError.code,
          message: H.ARCHIVED_MESSAGE,
        }),
      onRight: () => expect.fail(),
    });

    service.close();
    yield* regOwner.client.close();
    yield* regReceiver.client.close();
  }));
