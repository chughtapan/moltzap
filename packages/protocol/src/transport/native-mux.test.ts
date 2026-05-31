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
      parser: RpcSerialization.json.unsafeMake(),
      inject: (frame) =>
        Effect.sync(() => {
          received.push(frame);
        }),
    },
  };
}

// Drive the server engine-facing `send` with `frame`; assert the captured
// envelope is on channel c2s and its `f` payload roundtrips back to `frame`.
const serverSendRoundtrips = (frame: Record<string, unknown>) =>
  Effect.gen(function* () {
    const wire = recordingWire();
    const disconnects = yield* Mailbox.make<number>();
    const builder = makeServerChannelProtocol({
      channel: "c2s",
      write: wire.write,
      disconnects,
    });
    const built = yield* builder(noopInject);
    yield* built.impl.send(0, frame as never);
    const env = soleEnvelope(wire.written);
    expect(env.ch).toBe("c2s");
    expect(RpcSerialization.json.unsafeMake().decode(env.f)).toEqual([frame]);
  });

// Encode `frame` on the c2s channel, route the envelope, assert it lands
// verbatim in the c2s sink and nowhere else.
const routesToMatchingSink = (frame: Record<string, unknown>) =>
  Effect.gen(function* () {
    const c2s = recordingSink();
    const s2c = recordingSink();
    const encoded = c2s.sink.parser.encode(frame) as string;
    const env = JSON.stringify({ ch: "c2s", f: encoded });
    yield* routeInbound(env, { c2s: c2s.sink, s2c: s2c.sink });
    expect(c2s.received).toEqual([frame]);
    expect(s2c.received).toEqual([]);
  });

const jsonFrame = fc.dictionary(fc.string(), fc.jsonValue());

describe("native-mux envelope", () => {
  it("server send wraps the frame in a {ch, f} envelope that roundtrips", () => {
    const property = fc.property(jsonFrame, (frame) =>
      Effect.runSync(serverSendRoundtrips(frame)),
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
        yield* built.impl.send({ hello: "world" } as never);
        const env = soleEnvelope(wire.written);
        expect(env.ch).toBe("s2c");
      }),
    ));
});

describe("native-mux routeInbound", () => {
  it("routes any well-formed envelope verbatim to the matching sink", () => {
    const property = fc.property(jsonFrame, (frame) =>
      Effect.runSync(routesToMatchingSink(frame)),
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
        const encoded = c2s.sink.parser.encode({ x: 1 }) as string;
        const env = JSON.stringify({ ch: "s2c", f: encoded });
        yield* routeInbound(env, { c2s: c2s.sink });
        expect(c2s.received).toEqual([]);
      }),
    ));
});
