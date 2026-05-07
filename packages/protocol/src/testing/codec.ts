/**
 * Frame codec for the testing primitives.
 *
 * Satisfies §5.A1/A2/A3/A4 and Invariant I3: every frame crossing a
 * primitive is `Value.Check`-validated before it is surfaced to property
 * code. Malformed-frame arbitraries are generated *here* so Tier A can
 * inject bit-flips, truncations, and oversized frames without leaking the
 * malformation strategy into the primitives.
 */
import { Effect } from "effect";
import { Value } from "@sinclair/typebox/value";
import {
  RequestFrameSchema,
  ResponseFrameSchema,
  NotificationFrameSchema,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
} from "../transport/wire.js";
import { type JsonRpcId } from "../transport/wire.js";
import { FrameSchemaError } from "./errors.js";

const BIT_FLIP_VARIANTS = 8;
const OVERSIZED_PADDING_BYTES = 65_536;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_MODULUS = 0x100000000;

/**
 * Valid JSON-RPC frame objects exposed on the wire. Requests carry
 * `method + id`, responses carry `id + result/error`, and notifications
 * carry `method` without `id`.
 */
export type AnyFrame = RequestFrame | ResponseFrame | NotificationFrame;
export type CorrelatedResponseFrame = ResponseFrame & {
  readonly id: JsonRpcId;
};

export function isRequestFrame(frame: AnyFrame): frame is RequestFrame {
  return "id" in frame && "method" in frame;
}

export function isResponseFrame(frame: AnyFrame): frame is ResponseFrame {
  return "id" in frame && ("result" in frame || "error" in frame);
}

export function isCorrelatedResponseFrame(
  frame: AnyFrame,
): frame is CorrelatedResponseFrame {
  return isResponseFrame(frame) && typeof frame.id === "string";
}

export function isNotificationFrame(
  frame: AnyFrame,
): frame is NotificationFrame {
  return !("id" in frame) && "method" in frame;
}

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
  return JSON.stringify(frame);
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
  return Effect.suspend(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return Effect.fail(
        new FrameSchemaError({
          direction,
          expected: "request",
          raw,
          reason: `json parse failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }

    if (parsed === null || typeof parsed !== "object") {
      return Effect.fail(
        new FrameSchemaError({
          direction,
          expected: "request",
          raw,
          reason: "frame must be a JSON object",
        }),
      );
    }

    if (Value.Check(ResponseFrameSchema, parsed)) {
      return Effect.succeed(parsed as AnyFrame);
    }
    if (Value.Check(RequestFrameSchema, parsed)) {
      return Effect.succeed(parsed as AnyFrame);
    }
    if (Value.Check(NotificationFrameSchema, parsed)) {
      return Effect.succeed(parsed as AnyFrame);
    }

    return Effect.fail(
      new FrameSchemaError({
        direction,
        expected: "request",
        raw,
        reason: firstValueError(RequestFrameSchema, parsed),
      }),
    );
  });
}

function firstValueError(
  schema: Parameters<typeof Value.Errors>[0],
  value: unknown,
): string {
  const iter = Value.Errors(schema, value);
  for (const err of iter) {
    return `${err.path}: ${err.message}`;
  }
  return "schema check failed";
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
  const rawJson = encodeFrame(base);
  // Deterministic LCG so a `seed` reproduces byte-for-byte. Not crypto.
  const rand = lcg(seed);

  switch (kind) {
    case "bit-flip": {
      if (rawJson.length === 0) return rawJson;
      const pos = Math.floor(rand() * rawJson.length);
      const ch = rawJson.charCodeAt(pos);
      // Flip one bit in the low byte (XOR with 1<<bit).
      const bit = Math.floor(rand() * BIT_FLIP_VARIANTS);
      const flipped = String.fromCharCode(ch ^ (1 << bit));
      return rawJson.slice(0, pos) + flipped + rawJson.slice(pos + 1);
    }
    case "truncated": {
      if (rawJson.length <= 1) return "";
      const keep = Math.max(1, Math.floor(rawJson.length * rand()));
      return rawJson.slice(0, keep);
    }
    case "oversized": {
      // Pad with a long run of whitespace-in-string to exceed likely frame caps.
      // Uses `_padding` field at top level of the JSON object, which
      // `additionalProperties: false` rejects — also triggers "extra-property"
      // under different framing, but here the point is byte-size.
      const padLen = OVERSIZED_PADDING_BYTES;
      const pad = "X".repeat(padLen);
      // Splice "_padding":"...", before the closing `}`.
      const idx = rawJson.lastIndexOf("}");
      if (idx === -1) return rawJson + pad;
      return `${rawJson.slice(0, idx)},"_padding":"${pad}"}`;
    }
    case "invalid-utf8": {
      // Insert a lone surrogate. JSON parser may accept; TypeBox Check rejects
      // because frame strings (method, id) are expected to be UTF-8 clean.
      const pos = Math.floor(rand() * rawJson.length);
      return rawJson.slice(0, pos) + "\uD800" + rawJson.slice(pos);
    }
    case "missing-required-field": {
      // Remove the `jsonrpc` required property.
      return rawJson.replace(/"jsonrpc":"2\.0",?/, "");
    }
    case "extra-property": {
      const idx = rawJson.lastIndexOf("}");
      if (idx === -1) return rawJson;
      return `${rawJson.slice(0, idx)},"__extra":${seed}}`;
    }
    default: {
      const _exhaustive: never = kind;
      return absurdMalformedFrameKind(_exhaustive);
    }
  }
}

function absurdMalformedFrameKind(kind: never): never {
  throw new Error(`malformFrame: unexpected kind ${String(kind)}`);
}

/**
 * Deterministic LCG (Numerical Recipes constants). Given the same seed,
 * yields the same sequence of floats in [0, 1). Good enough for reproducible
 * mutation offsets; not for cryptographic use.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return s / LCG_MODULUS;
  };
}
