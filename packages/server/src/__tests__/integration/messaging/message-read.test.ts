import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { Chunk, Duration, Effect, Either, Fiber, Stream } from "effect";

import {
  type ConversationCheckpoint,
  messageReceivedNotificationDefinition,
  messagesRead,
  messagesSend,
  type Message,
} from "@moltzap/protocol/message";
import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import type { ListCursor } from "@moltzap/protocol/rpc";
import { WIRE_ERROR_TAG } from "@moltzap/protocol/testing";
import { ConversationService } from "#conversation";
import { MessageService } from "#message";
import {
  getKyselyDb,
  getTestCoreApp,
  it,
  registerAndConnect,
  resetTestDbEffect,
  setupAgentPair,
  startTestServerEffect,
  stopTestServerEffect,
  type ConnectedAgent,
} from "../helpers.js";

const READ_PAGE_SIZE = 50;
const OVERFLOW_MESSAGE_COUNT = READ_PAGE_SIZE + 1;
const READ_SETTLE_MS = 100;
const SUBSCRIBE_SETTLE = "10 millis";
const TEST_TIMEOUT_MS = 30_000;

beforeAll(() => Effect.runPromise(startTestServerEffect()), 60_000);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function expectWireErrorTag(
  outcome: Either.Either<unknown, unknown>,
  tag: string,
): void {
  Either.match(outcome, {
    onLeft: (error) => {
      expect(
        /* Safe because wire errors are a tagged union asserted by discriminant. */
        (error as { readonly _tag?: string })._tag,
      ).toBe(tag);
    },
    onRight: () => expect.fail(`expected ${tag}`),
  });
}

interface ReadFixture {
  readonly alice: ConnectedAgent;
  readonly intruder: ConnectedAgent;
  readonly conversationId: ConversationId;
  readonly otherConversationId: ConversationId;
  readonly sent: readonly Message[];
}

interface ReadPosition {
  readonly checkpoint: ConversationCheckpoint;
  readonly cursor: ListCursor;
  readonly nextCheckpoint: ConversationCheckpoint;
}

function sendSourceMessages(
  alice: ConnectedAgent,
  conversationId: ConversationId,
) {
  return Effect.gen(function* () {
    const sent: Message[] = [];
    for (let index = 1; index <= OVERFLOW_MESSAGE_COUNT; index++) {
      const result = yield* alice.client.sendRpc(messagesSend, {
        conversationId,
        parts: [{ type: "text", text: `source-${index}` }],
      });
      sent.push(result.message);
    }
    return sent;
  });
}

function setupReadFixture() {
  return Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    const intruder = yield* registerAndConnect("message-read-intruder");
    const created = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });
    const other = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });
    const sent = yield* sendSourceMessages(alice, created.conversation.id);
    return {
      alice,
      intruder,
      conversationId: created.conversation.id,
      otherConversationId: other.conversation.id,
      sent,
    } satisfies ReadFixture;
  });
}

function readFrozenPages(fixture: ReadFixture) {
  return Effect.gen(function* () {
    const firstPage = yield* fixture.alice.client.sendRpc(messagesRead, {
      conversationId: fixture.conversationId,
    });
    expect(firstPage.messages.map((message) => message.id)).toEqual(
      fixture.sent.slice(0, READ_PAGE_SIZE).map((message) => message.id),
    );
    const cursor = firstPage.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) {
      return yield* Effect.dieMessage("first read page must have a cursor");
    }

    const inserted = yield* fixture.alice.client.sendRpc(messagesSend, {
      conversationId: fixture.conversationId,
      parts: [{ type: "text", text: "after-frozen-window" }],
    });
    const secondPage = yield* fixture.alice.client.sendRpc(messagesRead, {
      conversationId: fixture.conversationId,
      cursor,
    });
    expect(secondPage.messages.map((message) => message.id)).toEqual(
      fixture.sent.slice(READ_PAGE_SIZE).map((message) => message.id),
    );
    expect(secondPage.checkpoint).toBe(firstPage.checkpoint);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(secondPage.messages.map((message) => message.id)).not.toContain(
      inserted.message.id,
    );
    return { firstPage, cursor, inserted };
  });
}

function readNextCheckpoint(
  fixture: ReadFixture,
  frozen: Effect.Effect.Success<ReturnType<typeof readFrozenPages>>,
) {
  return Effect.gen(function* () {
    const app = getTestCoreApp();
    const db = getKyselyDb();
    const restartedService = new MessageService({
      db,
      conversations: new ConversationService(db, app.connections),
      networkSend: app.networkSendService,
    });
    const nextWindow = yield* restartedService.read({
      conversationId: fixture.conversationId,
      requesterAgentId: fixture.alice.agentId,
      checkpoint: frozen.firstPage.checkpoint,
    });
    expect(nextWindow.messages.map((message) => message.id)).toEqual([
      frozen.inserted.message.id,
    ]);
    const noChange = yield* fixture.alice.client.sendRpc(messagesRead, {
      conversationId: fixture.conversationId,
      checkpoint: nextWindow.checkpoint,
    });
    expect(noChange.messages).toEqual([]);
    expect(noChange.checkpoint).toBe(nextWindow.checkpoint);
    return {
      checkpoint: frozen.firstPage.checkpoint,
      cursor: frozen.cursor,
      nextCheckpoint: nextWindow.checkpoint,
    } satisfies ReadPosition;
  });
}

function assertPositionValidation(
  fixture: ReadFixture,
  position: ReadPosition,
) {
  return Effect.gen(function* () {
    const crossCheckpoint = yield* Effect.either(
      fixture.alice.client.sendRpc(messagesRead, {
        conversationId: fixture.otherConversationId,
        checkpoint: position.checkpoint,
      }),
    );
    expectWireErrorTag(crossCheckpoint, WIRE_ERROR_TAG.InvalidParams);
    const crossCursor = yield* Effect.either(
      fixture.alice.client.sendRpc(messagesRead, {
        conversationId: fixture.otherConversationId,
        cursor: position.cursor,
      }),
    );
    expectWireErrorTag(crossCursor, WIRE_ERROR_TAG.InvalidParams);
    const conflictingPosition = yield* Effect.either(
      fixture.alice.client.sendRpc(messagesRead, {
        conversationId: fixture.conversationId,
        checkpoint: position.checkpoint,
        cursor: position.cursor,
      }),
    );
    expectWireErrorTag(conflictingPosition, WIRE_ERROR_TAG.InvalidParams);

    // Authorization precedes token validation, so an outsider learns nothing
    // about the mutually exclusive positions supplied with the request.
    const inaccessible = yield* Effect.either(
      fixture.intruder.client.sendRpc(messagesRead, {
        conversationId: fixture.conversationId,
        checkpoint: position.checkpoint,
        cursor: position.cursor,
      }),
    );
    expectWireErrorTag(inaccessible, WIRE_ERROR_TAG.Forbidden);
  });
}

function assertReadDoesNotNotify(
  fixture: ReadFixture,
  checkpoint: ConversationCheckpoint,
) {
  return Effect.gen(function* () {
    const notifications = yield* fixture.alice.client
      .subscribe(messageReceivedNotificationDefinition)
      .pipe(
        Stream.interruptAfter(Duration.millis(READ_SETTLE_MS)),
        Stream.runCollect,
        Effect.fork,
      );
    yield* Effect.sleep(SUBSCRIBE_SETTLE);
    yield* fixture.alice.client.sendRpc(messagesRead, {
      conversationId: fixture.conversationId,
      checkpoint,
    });
    expect(Chunk.toReadonlyArray(yield* Fiber.join(notifications))).toEqual([]);
  });
}

it(
  "reads a frozen checkpoint window in source order without dispatch side effects",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setupReadFixture();
      const frozen = yield* readFrozenPages(fixture);
      const position = yield* readNextCheckpoint(fixture, frozen);
      yield* assertPositionValidation(fixture, position);
      yield* assertReadDoesNotNotify(fixture, position.nextCheckpoint);
    }),
  TEST_TIMEOUT_MS,
);
