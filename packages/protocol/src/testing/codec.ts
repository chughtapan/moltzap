/**
 * Frame codec for the testing primitives.
 *
 * Satisfies §5.A1/A2/A3/A4 and Invariant I3: every frame crossing a
 * primitive is `Value.Check`-validated before it is surfaced to property
 * code. Malformed-frame arbitraries are generated *here* so Tier A can
 * inject bit-flips, truncations, and oversized frames without leaking the
 * malformation strategy into the primitives.
 */
import type { Effect } from "effect";
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
} from "../schema/frames.js";
import type { FrameSchemaError } from "./errors.js";

/**
 * Valid-frame kinds exposed on the wire. The string literal discriminator
 * matches the `type` field in `RequestFrameSchema` / `ResponseFrameSchema`
 * and the outer `type: "event"` sentinel for `EventFrameSchema`.
 */
export type AnyFrame =
  | ({ readonly type: "request" } & RequestFrame)
  | ({ readonly type: "response" } & ResponseFrame)
  | ({ readonly type: "event" } & EventFrame);

/**
 * Kinds of malformation Tier A / Tier D-slicer can inject. Each maps to a
 * deterministic mutation driven by fast-check so shrinks reproduce.
 */
export type MalformedFrameKind =
  | "bit-flip"
  | "truncated"
  | "oversized"
  | "invalid-utf8"
  | "missing-required-field"
  | "extra-property";

/** Serialize a typed frame to the wire bytes. */
export function encodeFrame(frame: AnyFrame): string {
  throw new Error("not implemented");
}

/**
 * Parse + `Value.Check` an inbound frame. `FrameSchemaError` captures
 * the failing branch so Tier A can assert "drop or typed error, never
 * crash."
 */
export function decodeFrame(
  raw: string,
  direction: "outbound" | "inbound",
): Effect.Effect<AnyFrame, FrameSchemaError> {
  throw new Error("not implemented");
}

/**
 * Produce a malformed wire payload from a valid frame. The mutation is
 * deterministic given the `kind` + `seed`; replaying with the same seed
 * reproduces the exact bytes. Used by Tier A (A4) and Tier D (D3).
 */
export function malformFrame(
  base: AnyFrame,
  kind: MalformedFrameKind,
  seed: number,
): string {
  throw new Error("not implemented");
}
