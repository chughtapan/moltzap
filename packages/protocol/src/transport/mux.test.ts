/**
 * Unit tests for the two-engine transport (`mux.ts`).
 *
 * Two invariants:
 *   - a channel `send` writes the bare frame verbatim — a fresh JSON Parser
 *     recovers the original frame (roundtrip), with no envelope wrapper;
 *   - `routeInbound` routes by frame family: a request-family frame (carries a
 *     top-level `method`) lands in the `server` sink, a response-family frame
 *     (no `method`) lands in the `client` sink, and non-JSON / non-object /
 *     no-sink chunks are dropped (or answered with a parse-error reply) without
 *     failing the socket.
 */
import { RpcSerialization } from "@effect/rpc";
import { Effect, Mailbox } from "effect";
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
  if (chunk === undefined) throw new Error("no chunk written");
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
const exitFrame = (requestId: string, value: unknown) =>
  ({
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value },
  }) as never;

// A valid `FromClientEncoded` request — the request family, which serializes
// to a frame carrying a top-level `method`. Routed to the `server` sink.
const requestFrame = (requestId: string, tag: string) =>
  ({
    _tag: "Request",
    id: requestId,
    tag,
    payload: {},
    headers: {},
    traceId: undefined,
    spanId: undefined,
    sampled: undefined,
  }) as never;

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
    const encoded = client.sink.parser.encode(
      exitFrame(REQUEST_ID, value),
    ) as string;
    yield* routeInbound(encoded, {
      server: server.sink,
      client: client.sink,
    });
    expect(client.received).toMatchObject([
      { requestId: REQUEST_ID, exit: { _tag: "Success", value } },
    ]);
    expect(server.received).toEqual([]);
  });

// `fc.jsonValue()` can produce `-0`, which `JSON.stringify` renders as `"0"`
// and parses back to `+0` — a value the JSON wire genuinely cannot preserve.
// The bare frame's contract is that a JSON-serializable frame round-trips;
// reject the `-0` outliers so the property pins exactly that, without asserting
// the wire preserves a distinction JSON does not carry.
const hasNegativeZero = (value: unknown): boolean => {
  if (Object.is(value, -0)) return true;
  if (Array.isArray(value)) return value.some(hasNegativeZero);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasNegativeZero);
  }
  return false;
};

describe("mux send", () => {
  it("server send writes a bare frame that roundtrips", () => {
    const property = fc.property(
      fc.jsonValue().filter((v) => !hasNegativeZero(v)),
      (value) => Effect.runSync(serverSendRoundtrips(value)),
    );
    fc.assert(property, { numRuns: 50 });
    expect(true).toBe(true);
  });

  it("client send writes a bare frame", () =>
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
    ));
});

describe("mux routeInbound", () => {
  it("routes any response-family frame verbatim to the client sink", () => {
    const property = fc.property(
      fc.jsonValue().filter((v) => !hasNegativeZero(v)),
      (value) => Effect.runSync(responseRoutesToClient(value)),
    );
    fc.assert(property, { numRuns: 50 });
    expect(true).toBe(true);
  });

  it("routes a request-family frame to the server sink", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const server = recordingSink();
        const client = recordingSink();
        const encoded = server.sink.parser.encode(
          requestFrame(REQUEST_ID, "agent/connect"),
        ) as string;
        yield* routeInbound(encoded, {
          server: server.sink,
          client: client.sink,
        });
        expect(server.received).toHaveLength(1);
        expect(client.received).toEqual([]);
      }),
    ));

  it("drops a non-JSON chunk without failing", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const client = recordingSink();
        yield* routeInbound("not json at all", { client: client.sink });
        expect(client.received).toEqual([]);
      }),
    ));

  it("drops a frame with no sink for its family", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const client = recordingSink();
        const encoded = client.sink.parser.encode(
          requestFrame("1", "agent/connect"),
        ) as string;
        // A request-family frame with only a `client` sink registered has no
        // `server` sink to route to.
        yield* routeInbound(encoded, { client: client.sink });
        expect(client.received).toEqual([]);
      }),
    ));
});
