/**
 * Frame mutator — malformed-frame fuzz injector for adversity properties.
 *
 * Phase 1B re-architect: replaces `testing/codec.ts`. The pre-reorg name
 * `codec` was a misnomer — `transport/wire.ts` is the real wire codec; this
 * file is the test-time mutator that takes a valid frame, applies one of six
 * deterministic mutations (`MalformedFrameKind`), and emits the malformed
 * bytes for adversity properties to inject.
 *
 * `FrameSchemaError` co-locates here because schema-check failures are
 * codec-local: every call site that raises it (`decodeFrame` plus the
 * wire-driver's frame-receive path) sees the schema check fail at this
 * layer, so the typed channel stays adjacent to the producers.
 */
import { Data, Effect, Either, ParseResult, Schema } from "effect";
import { decodesStrictly, STRICT_DECODE } from "../../../schema-primitives.js";
import {
  requestFrameSchema,
  responseFrameSchema,
  notificationFrameSchema,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
} from "../../../transport/wire.js";
import { type JsonRpcId } from "../../../transport/wire.js";

const BIT_FLIP_VARIANTS = 8;
const OVERSIZED_PADDING_BYTES = 65_536;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_MODULUS = 0x100000000;
const RequestFrameSchema = requestFrameSchema();
const ResponseFrameSchema = responseFrameSchema();
const NotificationFrameSchema = notificationFrameSchema();

// Strict, excess-rejecting decode check (former AJV `strict` `Value.Check`).
// `decodesStrictly` passes `{ onExcessProperty: "error" }`, which is
// LOAD-BEARING: the `extra-property` / `oversized` mutators below append a
// stray key, and the adversity properties assert those frames FAIL the schema
// check — a bare decode would silently strip the key and INVERT the assertion.
const decodeRequestEither = Schema.decodeUnknownEither(RequestFrameSchema);

/** A frame read off the wire failed the strict schema check. */
export class FrameSchemaError extends Data.TaggedError(
  "TestingFrameSchemaError",
)<{
  readonly direction: "outbound" | "inbound";
  readonly expected: "request" | "response" | "event";
  readonly raw: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.expected} (${this.direction}): ${this.reason} — raw: ${this.raw.slice(0, 200)}`;
  }
}

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

/** Parses and validates an inbound frame. */
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

    if (
      decodesStrictly(ResponseFrameSchema, parsed) ||
      decodesStrictly(RequestFrameSchema, parsed) ||
      decodesStrictly(NotificationFrameSchema, parsed)
    ) {
      return Effect.succeed(parsed as AnyFrame);
    }

    return Effect.fail(
      new FrameSchemaError({
        direction,
        expected: "request",
        raw,
        reason: firstParseError(parsed),
      }),
    );
  });
}

function firstParseError(value: unknown): string {
  return Either.match(decodeRequestEither(value, STRICT_DECODE), {
    onRight: () => "schema check failed",
    onLeft: (parseError) => {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(parseError);
      const first = issues[0];
      return first
        ? `${first.path.join("/")}: ${first.message}`
        : "schema check failed";
    },
  });
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
  const rand = lcg(seed);

  switch (kind) {
    case "bit-flip":
      return malformBitFlip(rawJson, rand);
    case "truncated":
      return malformTruncated(rawJson, rand);
    case "oversized":
      return malformOversized(rawJson);
    case "invalid-utf8":
      return malformInvalidUtf8(rawJson, rand);
    case "missing-required-field":
      return malformMissingRequiredField(rawJson);
    case "extra-property":
      return malformExtraProperty(rawJson, seed);
    default: {
      const _exhaustive: never = kind;
      return absurdMalformedFrameKind(_exhaustive);
    }
  }
}

function malformBitFlip(rawJson: string, rand: () => number): string {
  if (rawJson.length === 0) return rawJson;
  const pos = Math.floor(rand() * rawJson.length);
  const ch = rawJson.charCodeAt(pos);
  const bit = Math.floor(rand() * BIT_FLIP_VARIANTS);
  const flipped = String.fromCharCode(ch ^ (1 << bit));
  return rawJson.slice(0, pos) + flipped + rawJson.slice(pos + 1);
}

function malformTruncated(rawJson: string, rand: () => number): string {
  if (rawJson.length <= 1) return "";
  const keep = Math.max(1, Math.floor(rawJson.length * rand()));
  return rawJson.slice(0, keep);
}

function malformOversized(rawJson: string): string {
  const pad = "X".repeat(OVERSIZED_PADDING_BYTES);
  const idx = rawJson.lastIndexOf("}");
  if (idx === -1) return rawJson + pad;
  return `${rawJson.slice(0, idx)},"_padding":"${pad}"}`;
}

function malformInvalidUtf8(rawJson: string, rand: () => number): string {
  const pos = Math.floor(rand() * rawJson.length);
  return rawJson.slice(0, pos) + "\uD800" + rawJson.slice(pos);
}

function malformMissingRequiredField(rawJson: string): string {
  return rawJson.replace(/"jsonrpc":"2\.0",?/, "");
}

function malformExtraProperty(rawJson: string, seed: number): string {
  const idx = rawJson.lastIndexOf("}");
  if (idx === -1) return rawJson;
  return `${rawJson.slice(0, idx)},"__extra":${seed}}`;
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
