/**
 * Unit tests for the two-engine transport (`mux.ts`).
 *
 * Two invariants:
 *   - a channel `send` writes the bare frame verbatim — a fresh JSON Parser
 *     recovers the original frame (roundtrip), with no envelope wrapper;
 *   - `routeInbound` routes by frame family: a request-family frame (carries a
 *     top-level `method`) lands in the `server` sink, a response-family frame
 *     (no `method`) lands in the `client` sink, while malformed, unroutable,
 *     parser-rejected, and injector-rejected frames fail the read path.
 */
import { RpcSerialization } from "@effect/rpc";
import * as Socket from "@effect/platform/Socket";
import { Cause, Effect, Exit, Mailbox, Option } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  makeClientChannelProtocol,
  makeServerChannelProtocol,
  routeInbound,
  type ChannelSink,
} from "./mux.js";

// The engine `write` injector each builder takes; the send tests never
// exercise inbound, so a no-op suffices.
const noopInject = () => Effect.void;

// Read the sole captured wire chunk, asserting exactly one chunk was written.
function soleChunk(written: readonly string[]): string {
  expect(written).toHaveLength(1);
  const [chunk] = written;
  if (chunk === undefined) {
    throw new Error("no chunk written");
  }
  return chunk;
}

function recordingWire() {
  const written: string[] = [];
  return {
    written,
    write: (chunk: string) =>
      Effect.sync(() => {
        written.push(chunk);
      }),
  };
}

function recordingSink(): {
  readonly sink: ChannelSink;
  readonly received: unknown[];
} {
  const received: unknown[] = [];
  return {
    received,
    sink: {
      parser: RpcSerialization.jsonRpc().unsafeMake(),
      inject: (frame) =>
        Effect.sync(() => {
          received.push(frame);
        }),
    },
  };
}

// A valid `FromServerEncoded` response — the response family (`Exit`), which
// serializes to a frame with no top-level `method`. Routed to the `client`
// sink.
const exitFrame = (requestId: string, value: unknown): never => {
  const frame = {
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value },
  };
  return /* Safe because this fixture mirrors @effect/rpc's encoded Exit frame contract. */ frame as never;
};

// A valid `FromClientEncoded` request — the request family, which serializes
// to a frame carrying a top-level `method`. Routed to the `server` sink.
const requestFrame = (requestId: string, tag: string): never => {
  const frame = {
    _tag: "Request",
    id: requestId,
    tag,
    payload: {},
    headers: {},
    traceId: undefined,
    spanId: undefined,
    sampled: undefined,
  };
  return /* Safe because this fixture mirrors @effect/rpc's encoded Request frame contract. */ frame as never;
};

// Decode a bare wire string with a fresh jsonRpc parser and return the lone
// decoded frame.
const decodeOne = (wire: string): unknown => {
  const [frame] = RpcSerialization.jsonRpc().unsafeMake().decode(wire);
  return frame;
};

// The jsonRpc wire id must be a non-falsy numeric value (`id: requestId &&
// Number(requestId)`); an empty string collapses to `undefined`. Use a fixed
// numeric request id and vary only the success value.
const REQUEST_ID = "7";
const READ_FAILURE = "Read";
const WRITE_FAILURE = "Write";
const PARSER_REJECTION = "fixture parser rejection";
const INJECTOR_REJECTION = "fixture injector rejection";
const WRITE_REJECTION = "fixture write rejection";

// Drive the server engine-facing `send` with a response frame; assert the
// captured chunk is the bare frame and decodes back to an Exit carrying the
// same success value (the id round-trips numerically).
const serverSendRoundtrips = (value: unknown) =>
  Effect.gen(function* () {
    const wire = recordingWire();
    const disconnects = yield* Mailbox.make<number>();
    const builder = makeServerChannelProtocol({
      write: wire.write,
      disconnects,
    });
    const built = yield* builder(noopInject);
    yield* built.impl.send(0, exitFrame(REQUEST_ID, value));
    const chunk = soleChunk(wire.written);
    expect(decodeOne(chunk)).toMatchObject({
      requestId: REQUEST_ID,
      exit: { _tag: "Success", value },
    });
  });

// Encode a response frame, route the bare frame, assert it lands in the
// `client` sink (no `method`) and nowhere else.
const responseRoutesToClient = (value: unknown) =>
  Effect.gen(function* () {
    const server = recordingSink();
    const client = recordingSink();
    const encoded = encodedResponseWithValue(client.sink.parser, value);
    yield* routeInbound(encoded, {
      server: server.sink,
      client: client.sink,
    });
    expect(client.received).toMatchObject([
      { requestId: REQUEST_ID, exit: { _tag: "Success", value } },
    ]);
    expect(server.received).toEqual([]);
  });

function rejectingSink(parser: RpcSerialization.Parser): ChannelSink {
  return {
    parser,
    inject: () => {
      throw new Error(INJECTOR_REJECTION);
    },
  };
}

function parserRejectingSink(): ChannelSink {
  const parser = RpcSerialization.jsonRpc().unsafeMake();
  return {
    parser: {
      encode: parser.encode,
      decode: () => {
        throw new Error(PARSER_REJECTION);
      },
    },
    inject: noopInject,
  };
}

function encodedResponse(parser: RpcSerialization.Parser): string {
  return encodedResponseWithValue(parser, { accepted: false });
}

function encodedResponseWithValue(
  parser: RpcSerialization.Parser,
  value: unknown,
): string {
  const encoded = parser.encode(exitFrame(REQUEST_ID, value));
  if (typeof encoded !== "string") {
    throw new Error("expected JSON-RPC text encoding");
  }
  return encoded;
}

function readFailure(
  effect: Effect.Effect<void, Socket.SocketError>,
): Socket.SocketError {
  const failure = Effect.runSync(effect.pipe(Effect.flip));
  expect(failure.reason).toBe(READ_FAILURE);
  return failure;
}

function failingWire(): {
  readonly failure: Socket.SocketError;
  readonly write: () => Effect.Effect<never, Socket.SocketError>;
} {
  const failure = new Socket.SocketGenericError({
    reason: WRITE_FAILURE,
    cause: WRITE_REJECTION,
  });
  return {
    failure,
    write: () => Effect.fail(failure),
  };
}

function expectWriteDefect(
  exit: Exit.Exit<void>,
  expected: Socket.SocketError,
): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Option.getOrUndefined(Cause.dieOption(exit.cause))).toBe(expected);
  }
}

// `fc.jsonValue()` can produce `-0`, which `JSON.stringify` renders as `"0"`
// and parses back to `+0` — a value the JSON wire genuinely cannot preserve.
// The bare frame's contract is that a JSON-serializable frame round-trips;
// reject the `-0` outliers so the property pins exactly that, without asserting
// the wire preserves a distinction JSON does not carry.
const hasNegativeZero = (value: unknown): boolean => {
  if (Object.is(value, -0)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasNegativeZero);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasNegativeZero);
  }
  return false;
};

describe("mux send encoding", () => {
  it("server send writes a bare frame that roundtrips", () => {
    const property = fc.property(
      fc.jsonValue().filter((v) => !hasNegativeZero(v)),
      (value) => {
        Effect.runSync(serverSendRoundtrips(value));
      },
    );
    fc.assert(property, { numRuns: 50 });
    expect(true).toBe(true);
  });

  it("client send writes a bare frame", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const wire = recordingWire();
        const builder = makeClientChannelProtocol({ write: wire.write });
        const built = yield* builder(noopInject);
        yield* built.impl.send(exitFrame("1", { hello: "world" }));
        const chunk = soleChunk(wire.written);
        expect(decodeOne(chunk)).toMatchObject({
          requestId: "1",
          exit: { _tag: "Success", value: { hello: "world" } },
        });
      }),
    );
  });
});

describe("mux send failures", () => {
  it("server send defects when the socket write fails", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const wire = failingWire();
        const disconnects = yield* Mailbox.make<number>();
        const builder = makeServerChannelProtocol({
          write: wire.write,
          disconnects,
        });
        const built = yield* builder(noopInject);
        const exit = yield* built.impl
          .send(0, exitFrame(REQUEST_ID, null))
          .pipe(Effect.exit);
        expectWriteDefect(exit, wire.failure);
      }),
    );
  });

  it("client send defects when the socket write fails", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const wire = failingWire();
        const builder = makeClientChannelProtocol({ write: wire.write });
        const built = yield* builder(noopInject);
        const exit = yield* built.impl
          .send(requestFrame(REQUEST_ID, "agent/network/connect"))
          .pipe(Effect.exit);
        expectWriteDefect(exit, wire.failure);
      }),
    );
  });
});

describe("mux routeInbound routing", () => {
  it("routes any response-family frame verbatim to the client sink", () => {
    const property = fc.property(
      fc.jsonValue().filter((v) => !hasNegativeZero(v)),
      (value) => {
        Effect.runSync(responseRoutesToClient(value));
      },
    );
    fc.assert(property, { numRuns: 50 });
    expect(true).toBe(true);
  });

  it("routes a request-family frame to the server sink", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const server = recordingSink();
        const client = recordingSink();
        const encoded = encodedRequest(
          server.sink.parser,
          REQUEST_ID,
          "agent/network/connect",
        );
        yield* routeInbound(encoded, {
          server: server.sink,
          client: client.sink,
        });
        expect(server.received).toHaveLength(1);
        expect(client.received).toEqual([]);
      }),
    );
  });
});

// @agent-code-guard/regression-only: each entry is one closed transport failure boundary; arbitrary valid-frame routing is covered in the generative sibling scope
describe("mux routeInbound failures", () => {
  it("fails the read path on non-JSON instead of replying or continuing", () => {
    const client = recordingSink();
    readFailure(routeInbound("not json at all", { client: client.sink }));
    expect(client.received).toEqual([]);
  });

  it("fails the read path on a non-object JSON body", () => {
    const client = recordingSink();
    readFailure(routeInbound("[]", { client: client.sink }));
    expect(client.received).toEqual([]);
  });

  it("fails the read path when the frame family has no sink", () => {
    const client = recordingSink();
    const encoded = encodedRequest(
      client.sink.parser,
      "1",
      "agent/network/connect",
    );
    // A request-family frame with only a `client` sink registered has no
    // `server` sink to route to.
    readFailure(routeInbound(encoded, { client: client.sink }));
    expect(client.received).toEqual([]);
  });

  it("fails the read path when the selected parser rejects the frame", () => {
    const parser = RpcSerialization.jsonRpc().unsafeMake();
    const encoded = encodedResponse(parser);
    readFailure(routeInbound(encoded, { client: parserRejectingSink() }));
  });

  it("fails the read path when the engine injector rejects a decoded frame", () => {
    const parser = RpcSerialization.jsonRpc().unsafeMake();
    const encoded = encodedResponse(parser);
    readFailure(routeInbound(encoded, { client: rejectingSink(parser) }));
  });
});

function encodedRequest(
  parser: RpcSerialization.Parser,
  requestId: string,
  tag: string,
): string {
  const encoded = parser.encode(requestFrame(requestId, tag));
  if (typeof encoded !== "string") {
    throw new Error("expected JSON-RPC text encoding");
  }
  return encoded;
}
