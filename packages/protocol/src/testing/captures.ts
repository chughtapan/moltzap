/**
 * Bounded, ordered capture buffers. TestClient captures every frame the
 * real server replied with; TestServer captures every frame a real client
 * pushed in. Both are append-only ring buffers exposed as `Effect` Streams
 * so property code can `Stream.take` or `Stream.filter` without racing the
 * underlying fiber.
 *
 * Exhaustiveness: `CaptureKind` discriminates inbound vs outbound so the
 * same buffer can record both sides when a primitive is proxied through
 * Toxiproxy (Tier D).
 */
import { Effect, Ref, Stream, PubSub } from "effect";
import type { AnyFrame, MalformedFrameKind } from "./codec.js";

export type CaptureKind = "inbound" | "outbound";

/**
 * One recorded event. `frame` is `null` when the capture is a raw-bytes
 * record that failed to decode — Tier A's A4 property asserts on both the
 * raw bytes and the typed `FrameSchemaError` that fired.
 */
export interface CapturedFrame {
  readonly at: number; // monotonic ms since primitive start
  readonly kind: CaptureKind;
  readonly raw: string;
  readonly frame: AnyFrame | null;
  readonly malformed: MalformedFrameKind | null;
}

/** Opaque handle to a running buffer; held by TestClient / TestServer. */
export interface CaptureBuffer {
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
  readonly stream: Stream.Stream<CapturedFrame>;
  readonly clear: Effect.Effect<void>;
  /** @internal — used by primitives to append. Not exported from barrel. */
  readonly _publish: (entry: CapturedFrame) => Effect.Effect<void>;
  /** @internal — soft capacity so `mergeCaptures` can fan messages out safely. */
  readonly _capacity: number;
}

const startTime = Date.now();

/**
 * Ring-buffer + PubSub implementation. The Ref holds the bounded
 * array; PubSub fans each append out to every subscriber so `stream`
 * behaves as a live tail.
 */
export function makeCaptureBuffer(opts: {
  readonly capacity: number;
}): Effect.Effect<CaptureBuffer> {
  return Effect.gen(function* () {
    const cap = Math.max(1, opts.capacity);
    const ref = yield* Ref.make<ReadonlyArray<CapturedFrame>>([]);
    const pubsub = yield* PubSub.sliding<CapturedFrame>(cap);

    const publish = (entry: CapturedFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(ref, (cur) => {
          const next = cur.length >= cap ? cur.slice(1) : cur.slice();
          return [...next, entry];
        });
        yield* PubSub.publish(pubsub, entry);
      });

    const buf: CaptureBuffer = {
      snapshot: Ref.get(ref),
      stream: Stream.fromPubSub(pubsub),
      clear: Ref.set(ref, []),
      _publish: publish,
      _capacity: cap,
    };
    return buf;
  });
}

/**
 * Multiplex captures across many connections — used by Tier C properties
 * where N real clients emit concurrently and the property asserts on the
 * merged ordered stream.
 *
 * Semantics:
 *   - `snapshot` returns every buffer's current contents concatenated and
 *     sorted by `at` (stable for equal timestamps by buffer index).
 *   - `stream` is `Stream.mergeAll(stream...)` — live events in arrival order.
 *   - `clear` clears every upstream buffer.
 */
export function mergeCaptures(
  buffers: ReadonlyArray<CaptureBuffer>,
): Effect.Effect<CaptureBuffer> {
  return Effect.gen(function* () {
    const merged = yield* makeCaptureBuffer({
      capacity: buffers.reduce((sum, b) => sum + b._capacity, 0) || 1,
    });

    // Return a view that aggregates snapshots on demand rather than a live
    // merged copy: the source buffers are authoritative.
    const snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>> = Effect.gen(
      function* () {
        const snaps = yield* Effect.forEach(buffers, (b) => b.snapshot, {
          concurrency: "unbounded",
        });
        const flat = snaps.flat();
        return [...flat].sort((a, b) => a.at - b.at);
      },
    );

    const stream = Stream.mergeAll(
      buffers.map((b) => b.stream),
      { concurrency: "unbounded" },
    );
    const clear = Effect.forEach(buffers, (b) => b.clear, {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    return {
      snapshot,
      stream,
      clear,
      _publish: merged._publish,
      _capacity: merged._capacity,
    } satisfies CaptureBuffer;
  });
}

/** Internal hook used by primitives to push a decode failure as-bytes. */
export function recordMalformed(
  buffer: CaptureBuffer,
  raw: string,
  kind: MalformedFrameKind,
): Effect.Effect<void> {
  return buffer._publish({
    at: Date.now() - startTime,
    kind: "inbound",
    raw,
    frame: null,
    malformed: kind,
  });
}

/** Internal hook: push a successfully-decoded frame. */
export function recordFrame(
  buffer: CaptureBuffer,
  kind: CaptureKind,
  raw: string,
  frame: AnyFrame,
): Effect.Effect<void> {
  return buffer._publish({
    at: Date.now() - startTime,
    kind,
    raw,
    frame,
    malformed: null,
  });
}
