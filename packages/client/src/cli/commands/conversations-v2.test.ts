/**
 * Unit tests for the v2 subcommand handlers added to conversations.ts
 * (sbd#185). Keeps v1 tests untouched — lives in a sibling file so the
 * existing conversations test module is not edited at architect stage.
 *
 * Spec test-coverage floor: one success + one RPC-failure per handler.
 */
import { Effect, Exit } from "effect";
import { it as effectIt } from "@effect/vitest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  vi,
  type MockInstance,
} from "vitest";
import {
  conversationsArchiveHandler,
  conversationsGetHandler,
  conversationsUnarchiveHandler,
} from "./conversations.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";

import {
  ConversationsArchive,
  ConversationsGet,
  ConversationsUnarchive,
} from "@moltzap/protocol";

const it = effectIt.effect;
const CONVERSATION_ID = "00000000-0000-4000-8000-00000000000c";
const CONVERSATION_CREATED_BY = "00000000-0000-4000-8000-000000000aaa";
const CONVERSATION_TIMESTAMP = "2026-05-04T00:00:00.000Z";

const staticResponse =
  <A>(value: A) =>
  (): A =>
    value;

function getConversationBody() {
  return {
    conversation: {
      id: CONVERSATION_ID,
      type: "dm",
      createdBy: CONVERSATION_CREATED_BY,
      createdAt: CONVERSATION_TIMESTAMP,
      updatedAt: CONVERSATION_TIMESTAMP,
    },
    participants: [],
  };
}

function emptyCommandResult() {
  return {};
}

function notFoundError() {
  return new Error("404");
}

function transportFailure() {
  return new Error("fail");
}

describe("conversations get (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/get and prints { conversation, participants } as JSON", () =>
    Effect.gen(function* () {
      const body = getConversationBody();
      const { calls, transport } = makeFakeTransport(staticResponse(body));
      yield* conversationsGetHandler({ conversationId: CONVERSATION_ID }).pipe(
        Effect.provideService(Transport, transport),
      );
      expect(calls[0]).toEqual({
        method: ConversationsGet.name,
        params: { conversationId: CONVERSATION_ID },
      });
      expect(stdout).toHaveBeenCalledWith(JSON.stringify(body, null, 2));
    }));

  it("surfaces TransportRpcError", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport(notFoundError);
      const result = yield* Effect.exit(
        conversationsGetHandler({ conversationId: CONVERSATION_ID }).pipe(
          Effect.provideService(Transport, transport),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }));
});

describe("conversations archive (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/archive with the supplied id", () =>
    Effect.gen(function* () {
      const { calls, transport } = makeFakeTransport(emptyCommandResult);
      yield* conversationsArchiveHandler({
        conversationId: CONVERSATION_ID,
      }).pipe(Effect.provideService(Transport, transport));
      expect(calls[0]).toEqual({
        method: ConversationsArchive.name,
        params: { conversationId: CONVERSATION_ID },
      });
    }));

  it("surfaces TransportRpcError", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport(transportFailure);
      const result = yield* Effect.exit(
        conversationsArchiveHandler({ conversationId: CONVERSATION_ID }).pipe(
          Effect.provideService(Transport, transport),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }));
});

describe("conversations unarchive (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/unarchive with the supplied id", () =>
    Effect.gen(function* () {
      const { calls, transport } = makeFakeTransport(emptyCommandResult);
      yield* conversationsUnarchiveHandler({
        conversationId: CONVERSATION_ID,
      }).pipe(Effect.provideService(Transport, transport));
      expect(calls[0]).toEqual({
        method: ConversationsUnarchive.name,
        params: { conversationId: CONVERSATION_ID },
      });
    }));

  it("surfaces TransportRpcError", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport(transportFailure);
      const result = yield* Effect.exit(
        conversationsUnarchiveHandler({ conversationId: CONVERSATION_ID }).pipe(
          Effect.provideService(Transport, transport),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }));
});
