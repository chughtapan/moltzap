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
import {
  Transport,
  TransportRpcError,
  type Transport as TransportSurface,
  type TransportError,
} from "../transport.js";

type Call = { method: string; params: Record<string, unknown> };

const makeFakeTransport = (
  respond: (call: Call) => unknown | Error,
): { calls: Array<Call>; transport: TransportSurface } => {
  const calls: Array<Call> = [];
  const transport: TransportSurface = {
    kind: "test",
    rpc: <Result>(
      method: string,
      params: Record<string, unknown>,
    ): Effect.Effect<Result, TransportError> => {
      calls.push({ method, params });
      const out = respond({ method, params });
      if (out instanceof Error) {
        return Effect.fail(
          new TransportRpcError({ method, code: -32000, message: out.message }),
        );
      }
      return Effect.succeed(out as Result);
    },
  };
  return { calls, transport };
};

describe("conversations get (v2)", () => {
  let stdout: MockInstance;
  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => stdout.mockRestore());

  it("calls conversations/get and prints { conversation, participants } as JSON", async () => {
    const body = {
      conversation: { id: "c1", type: "dm" },
      participants: [],
    };
    const { calls, transport } = makeFakeTransport(() => body);
    await Effect.runPromise(
      conversationsGetHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: "conversations/get",
      params: { conversationId: "c1" },
    });
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(body, null, 2));
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("404"));
    const result = await Effect.runPromiseExit(
      conversationsGetHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
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
      conversationsArchiveHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: "conversations/archive",
      params: { conversationId: "c1" },
    });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      conversationsArchiveHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
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
      conversationsUnarchiveHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(calls[0]).toEqual({
      method: "conversations/unarchive",
      params: { conversationId: "c1" },
    });
  });

  it("surfaces TransportRpcError", async () => {
    const { transport } = makeFakeTransport(() => new Error("fail"));
    const result = await Effect.runPromiseExit(
      conversationsUnarchiveHandler({ conversationId: "c1" }).pipe(
        Effect.provideService(Transport, transport),
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});
