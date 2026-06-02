/**
 * Unit tests for the channel-multiplexed transport (`native-mux.ts`).
 *
 * Two invariants:
 *   - the `{ch, f}` envelope a channel `send` writes carries the frame
 *     verbatim — a fresh JSON Parser on `f` recovers the original frame
 *     (roundtrip), and `ch` names the sending channel;
 *   - `routeInbound` routes a well-formed envelope to the matching sink
 *     (verbatim, for any JSON frame), and drops non-JSON /
 *     malformed-envelope / unknown-channel chunks without failing.
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
  type MuxChannel,
} from "./native-mux.js";

interface CapturedEnvelope {
  readonly ch: MuxChannel;
  readonly f: string;
}

// The engine `write` injector each builder takes; the envelope/send tests
// never exercise inbound, so a no-op suffices.
const noopInject = () => Effect.void;

// Read the sole captured wire chunk as a decoded envelope, asserting one
// chunk was written.
function soleEnvelope(written: readonly string[]): CapturedEnvelope {
  expect(written).toHaveLength(1);
  const [chunk] = written;
  if (chunk === undefined) throw new Error("no chunk written");
  return JSON.parse(chunk) as CapturedEnvelope;
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

// A valid `FromServerEncoded` response — the only frame shape the endpoint
// serialization (`jsonRpc`) encodes. An arbitrary dictionary is not a wire
// response, so the encoder rejects it; the mux only ever carries engine
// frames, never raw payloads.
const exitFrame = (requestId: string, value: unknown) =>
  ({
    _tag: "Exit",
    requestId,
    exit: { _tag: "Success", value },
  }) as never;

// Decode an envelope's `f` with a fresh jsonRpc parser and return the lone
// decoded frame.
const decodeOne = (f: string): unknown => {
  const [frame] = RpcSerialization.jsonRpc().unsafeMake().decode(f);
  return frame;
};

// The jsonRpc wire id must be a non-falsy numeric value (`id: requestId &&
// Number(requestId)`); an empty string collapses to `undefined`. Use a fixed
// numeric request id and vary only the success value.
const REQUEST_ID = "7";

// Drive the server engine-facing `send` with a response frame; assert the
// captured envelope is on channel c2s and its `f` payload decodes back to an
// Exit carrying the same success value (the id round-trips numerically).
const serverSendRoundtrips = (value: unknown) =>
  Effect.gen(function* () {
    const wire = recordingWire();
    const disconnects = yield* Mailbox.make<number>();
    const builder = makeServerChannelProtocol({
      channel: "c2s",
      write: wire.write,
      disconnects,
    });
    const built = yield* builder(noopInject);
    yield* built.impl.send(0, exitFrame(REQUEST_ID, value));
    const env = soleEnvelope(wire.written);
    expect(env.ch).toBe("c2s");
    expect(decodeOne(env.f)).toMatchObject({
      requestId: REQUEST_ID,
      exit: { _tag: "Success", value },
    });
  });

// Encode a response frame on the c2s channel, route the envelope, assert it
// lands in the c2s sink and nowhere else.
const routesToMatchingSink = (value: unknown) =>
  Effect.gen(function* () {
    const c2s = recordingSink();
    const s2c = recordingSink();
    const encoded = c2s.sink.parser.encode(
      exitFrame(REQUEST_ID, value),
    ) as string;
    const env = JSON.stringify({ ch: "c2s", f: encoded });
    yield* routeInbound(env, { c2s: c2s.sink, s2c: s2c.sink });
    expect(c2s.received).toMatchObject([
      { requestId: REQUEST_ID, exit: { _tag: "Success", value } },
    ]);
    expect(s2c.received).toEqual([]);
  });

// `fc.jsonValue()` can produce `-0`, which `JSON.stringify` renders as `"0"`
// and parses back to `+0` — a value the JSON wire genuinely cannot preserve.
// The envelope's contract is that a JSON-serializable frame round-trips; reject
// the `-0` outliers so the property pins exactly that, without asserting the
// wire preserves a distinction JSON does not carry.
const hasNegativeZero = (value: unknown): boolean => {
  if (Object.is(value, -0)) return true;
  if (Array.isArray(value)) return value.some(hasNegativeZero);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasNegativeZero);
  }
  return false;
};

describe("native-mux envelope", () => {
  it("server send wraps the frame in a {ch, f} envelope that roundtrips", () => {
    const property = fc.property(
      fc.jsonValue().filter((v) => !hasNegativeZero(v)),
      (value) => Effect.runSync(serverSendRoundtrips(value)),
    );
    fc.assert(property, { numRuns: 50 });
    expect(true).toBe(true);
  });

  it("client send tags its envelope with its own channel", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const wire = recordingWire();
        const builder = makeClientChannelProtocol({
          channel: "s2c",
          write: wire.write,
        });
        const built = yield* builder(noopInject);
        yield* built.impl.send(exitFrame("1", { hello: "world" }));
        const env = soleEnvelope(wire.written);
        expect(env.ch).toBe("s2c");
      }),
    ));
});

describe("native-mux routeInbound", () => {
  it("routes any well-formed envelope verbatim to the matching sink", () => {
    const property = fc.property(
      fc.jsonValue().filter((v) => !hasNegativeZero(v)),
      (value) => Effect.runSync(routesToMatchingSink(value)),
    );
    fc.assert(property, { numRuns: 50 });
    expect(true).toBe(true);
  });

  it("drops a non-JSON chunk without failing", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const c2s = recordingSink();
        yield* routeInbound("not json at all", { c2s: c2s.sink });
        expect(c2s.received).toEqual([]);
      }),
    ));

  it("drops a chunk whose envelope is malformed", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const c2s = recordingSink();
        yield* routeInbound(JSON.stringify({ ch: "c2s" }), { c2s: c2s.sink });
        yield* routeInbound(JSON.stringify({ wrong: "shape" }), {
          c2s: c2s.sink,
        });
        expect(c2s.received).toEqual([]);
      }),
    ));

  it("drops a chunk for an unregistered channel", () =>
    Effect.runSync(
      Effect.gen(function* () {
        const c2s = recordingSink();
        const encoded = c2s.sink.parser.encode(
          exitFrame("1", { x: 1 }),
        ) as string;
        const env = JSON.stringify({ ch: "s2c", f: encoded });
        yield* routeInbound(env, { c2s: c2s.sink });
        expect(c2s.received).toEqual([]);
      }),
    ));
});
