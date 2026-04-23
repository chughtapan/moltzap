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
import type { Effect, Stream } from "effect";
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
}

export function makeCaptureBuffer(opts: {
  readonly capacity: number;
}): Effect.Effect<CaptureBuffer> {
  throw new Error("not implemented");
}

/**
 * Multiplex captures across many connections — used by Tier C properties
 * where N real clients emit concurrently and the property asserts on the
 * merged ordered stream.
 */
export function mergeCaptures(
  buffers: ReadonlyArray<CaptureBuffer>,
): Effect.Effect<CaptureBuffer> {
  throw new Error("not implemented");
}

/** Internal hook used by primitives to push a decode failure as-bytes. */
export function recordMalformed(
  buffer: CaptureBuffer,
  raw: string,
  kind: MalformedFrameKind,
): Effect.Effect<void> {
  throw new Error("not implemented");
}

/** Internal hook: push a successfully-decoded frame. */
export function recordFrame(
  buffer: CaptureBuffer,
  kind: CaptureKind,
  raw: string,
  frame: AnyFrame,
): Effect.Effect<void> {
  throw new Error("not implemented");
}
