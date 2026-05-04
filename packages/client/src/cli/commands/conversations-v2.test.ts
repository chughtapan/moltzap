/**
 * Unit tests for the v2 subcommand handlers added to conversations.ts
 * (sbd#185). Keeps v1 tests untouched — lives in a sibling file so the
 * existing conversations test module is not edited at architect stage.
 *
 * Spec test-coverage floor: one success + one RPC-failure per handler.
 */
import { Effect } from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
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

describe("conversations get (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/get and prints { conversation, participants } as JSON", async () => {
    const body = {
      conversation: {
        id: "00000000-0000-4000-8000-00000000000c",
        type: "dm",
        createdBy: "00000000-0000-4000-8000-000000000aaa",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      participants: [],
    };
    const { calls, transport } = makeFakeTransport(() => body);
    await Effect.runPromise(
      conversationsGetHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls[0]).toEqual({
      method: ConversationsGet.name,
      params: { conversationId: "00000000-0000-4000-8000-00000000000c" },
    });
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(body, null, 2));
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("404"));
    const result = await Effect.runPromiseExit(
      conversationsGetHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("conversations archive (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/archive with the supplied id", async () => {
    const { calls, transport } = makeFakeTransport(() => ({}));
    await Effect.runPromise(
      conversationsArchiveHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls[0]).toEqual({
      method: ConversationsArchive.name,
      params: { conversationId: "00000000-0000-4000-8000-00000000000c" },
    });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      conversationsArchiveHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});

describe("conversations unarchive (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/unarchive with the supplied id", async () => {
    const { calls, transport } = makeFakeTransport(() => ({}));
    await Effect.runPromise(
      conversationsUnarchiveHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(calls[0]).toEqual({
      method: ConversationsUnarchive.name,
      params: { conversationId: "00000000-0000-4000-8000-00000000000c" },
    });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      conversationsUnarchiveHandler({
        conversationId: "00000000-0000-4000-8000-00000000000c",
      }).pipe(Effect.provideService(Transport, transport)),
    );
    expect(result._tag).toBe("Failure");
  });
});
