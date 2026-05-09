/**
 * Frame mutator — malformed-frame fuzz injector for adversity properties.
 *
 * Phase 1B re-architect (arch-1b-r2): replaces `testing/codec.ts`
 * (~221 LOC). The pre-reorg name `codec` was a misnomer — `transport/wire.ts`
 * is the real wire codec; this file is the test-time mutator that takes a
 * valid frame, applies one of six deterministic mutations
 * (`MalformedFrameKind`), and emits the malformed bytes for adversity
 * properties to inject.
 *
 * `FrameSchemaError` co-locates here because schema-check failures are
 * codec-local: the only callers that raise it are the encode/decode paths
 * inside this file.
 *
 * Architect stub — implementer ports the existing module body verbatim and
 * inlines `FrameSchemaError` (currently in `testing/errors.ts`).
 */

import { type Data } from "effect";

// Public exports (preserved verbatim from `testing/codec.ts`; the barrel
// at `testing/index.ts` re-exports these names unchanged).

export type AnyFrame = never;
export type CorrelatedResponseFrame = never;
export type MalformedFrameKind = never;

export function isRequestFrame(): never {
  throw new Error("frame-mutator.isRequestFrame: stub");
}
export function isResponseFrame(): never {
  throw new Error("frame-mutator.isResponseFrame: stub");
}
export function isCorrelatedResponseFrame(): never {
  throw new Error("frame-mutator.isCorrelatedResponseFrame: stub");
}
export function isNotificationFrame(): never {
  throw new Error("frame-mutator.isNotificationFrame: stub");
}
export function encodeFrame(): never {
  throw new Error("frame-mutator.encodeFrame: stub");
}
export function decodeFrame(): never {
  throw new Error("frame-mutator.decodeFrame: stub");
}
export function malformFrame(): never {
  throw new Error("frame-mutator.malformFrame: stub");
}

// `FrameSchemaError` migrates here from `testing/errors.ts`. Co-locating
// keeps the schema-check failure mode adjacent to the only callers that
// raise it (decodeFrame).
export declare class FrameSchemaError extends (class {} as new (
  args: never,
) => Data.Case) {
  readonly _tag: "TestingFrameSchemaError";
  readonly direction: "outbound" | "inbound";
  readonly expected: "request" | "response" | "event";
  readonly raw: string;
  readonly reason: string;
}
