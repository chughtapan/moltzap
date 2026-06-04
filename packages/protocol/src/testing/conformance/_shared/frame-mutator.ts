/**
 * Frame mutator — malformed-frame fuzz injector + JSON-RPC frame builders for
 * the conformance driver.
 *
 * The driver assembles JSON-RPC frames (valid and adversarial) and classifies
 * frames read off the wire. `encodeFrame` serializes; `decodeFrame` classifies
 * by structural family; `malformFrame` takes a valid frame and applies one of
 * the deterministic mutations (`MalformedFrameKind`) for adversity properties.
 *
 * `FrameSchemaError` co-locates here because schema-check failures are
 * codec-local: every call site that raises it (`decodeFrame` plus the
 * wire-driver's frame-receive path) sees the check fail at this layer, so the
 * typed channel stays adjacent to the producers.
 */
import { Data, Effect, type Schema } from "effect";
import {
  JSON_RPC_VERSION,
  jsonRpcMethod,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
  type JsonRpcId,
  type JsonRpcMethod,
} from "../../../transport/index.js";
import { notificationDefinitions } from "../../../engine/rpc-method-groups.js";
import type {
  RpcDefinition,
  NotificationDefinition,
} from "../../../transport/method.js";

// The wire-method names the server fires as notifications. A server-pushed
// notification arrives as a void-result REQUEST (it carries an `id`), so an
// `id`-bearing frame is only a notification when its method is in this set — an
// app-callback request (e.g. `messages/authorize`) is NOT.
const NOTIFICATION_METHOD_NAMES = new Set<string>(
  notificationDefinitions.map((d) => d.name as string),
);

const BIT_FLIP_VARIANTS = 8;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_MODULUS = 0x100000000;

/** A frame read off the wire failed the structural family check. */
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
 * The wire `method` of an inbound server-originated NOTIFICATION, whether it
 * arrived as a bare notification frame OR as a void-result request (the server
 * fires notifications as RPCs and awaits the client's ack, so the captured
 * frame carries an `id`). Returns `null` for any frame that is not a known
 * notification method — an app-callback request (`messages/authorize`,
 * `dispatch/authorize`, `task/create`) carries an `id` too but is NOT a
 * notification, so the method allowlist gates it out. Capture-scanning
 * conformance properties read this instead of {@link isNotificationFrame} so
 * they observe notifications regardless of the request/notification framing
 * without miscounting a callback request as a delivered notification.
 */
export function inboundNotificationMethod(frame: AnyFrame): string | null {
  if (isNotificationFrame(frame)) return frame.method;
  if (isRequestFrame(frame) && NOTIFICATION_METHOD_NAMES.has(frame.method)) {
    return frame.method;
  }
  return null;
}

// ── Frame builders ───────────────────────────────────────────────────
//
// Pure object-literal constructors over a descriptor + params. The driver
// assembles outbound frames with these; the `@effect/rpc` engines own the
// production encode path.

/** The wire `error` sub-object: the tagged error's `_tag` discriminant + supplement. */
// eslint-disable-next-line agent-code-guard/manual-tagged-error -- wire envelope type (the `_tag` projection of a `Schema.TaggedError`), not a tagged-error class
export type ResponseFrameError = {
  _tag: string;
  message?: string;
  data?: unknown;
};

export type ResponseFrameBody =
  | { result: unknown }
  | { error: ResponseFrameError };

export function requestFrame<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
  R extends Schema.Schema.AnyNoContext,
>(
  id: string,
  definition: RpcDefinition<Name, P, R>,
  params: Schema.Schema.Type<P>,
): RequestFrame & {
  readonly method: JsonRpcMethod<Name>;
  readonly params: Schema.Schema.Type<P>;
} {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id as JsonRpcId,
    method: definition.name,
    params,
  } as RequestFrame & {
    readonly method: JsonRpcMethod<Name>;
    readonly params: Schema.Schema.Type<P>;
  };
}

export function responseFrame(
  id: string | null,
  body: ResponseFrameBody,
): ResponseFrame {
  if (id === null) {
    return { jsonrpc: JSON_RPC_VERSION, id: null, ...body } as ResponseFrame;
  }
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id as JsonRpcId,
    ...body,
  } as ResponseFrame;
}

export function notificationFrame<
  Name extends string,
  P extends Schema.Schema.AnyNoContext,
>(
  definition: NotificationDefinition<Name, P>,
  params: Schema.Schema.Type<P>,
): NotificationFrame & {
  readonly method: JsonRpcMethod<Name>;
  readonly params: Schema.Schema.Type<P>;
} {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: definition.name,
    params,
  } as NotificationFrame & {
    readonly method: JsonRpcMethod<Name>;
    readonly params: Schema.Schema.Type<P>;
  };
}

/** Build a notification frame from a raw method name (no descriptor). */
export function rawNotificationFrame(
  method: string,
  params: unknown,
): NotificationFrame {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: jsonRpcMethod(method),
    ...(params !== undefined ? { params } : {}),
  } as NotificationFrame;
}

// ── Codec ────────────────────────────────────────────────────────────

/** Serialize a typed frame to the wire bytes. */
export function encodeFrame(frame: AnyFrame): string {
  return JSON.stringify(frame);
}

type FrameCheck =
  | { readonly object: { readonly [k: string]: unknown } }
  | { readonly reason: string };

/** Parse a wire string into a JSON object, or a reason if it is not one. */
function parseFrameObject(raw: string): FrameCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reason: `json parse failed: ${detail}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "frame must be a JSON object" };
  }
  return { object: { ...parsed } };
}

/** Reason the object is not a well-formed JSON-RPC family, or `null` if it is. */
function frameFamilyReason(obj: {
  readonly [k: string]: unknown;
}): string | null {
  if (obj["jsonrpc"] !== JSON_RPC_VERSION) return "jsonrpc must be 2.0";
  const hasMethod = typeof obj["method"] === "string";
  const hasBody = "result" in obj || "error" in obj;
  // request / notification (method present), or a response (no method, id +
  // body). Excess keys are ignored — the `@effect/rpc` engines strip them.
  if (hasMethod || ("id" in obj && hasBody)) return null;
  return "frame matches no JSON-RPC family";
}

/**
 * Classify an inbound frame by structural family. Lenient on excess keys: the
 * `@effect/rpc` engines strip unknown keys, so the driver matches that and does
 * NOT reject a frame carrying extra fields — it classifies on the discriminant
 * keys only (`method`, `id`, `result`, `error`).
 */
export function decodeFrame(
  raw: string,
  direction: "outbound" | "inbound",
): Effect.Effect<AnyFrame, FrameSchemaError> {
  return Effect.suspend(() => {
    const fail = (reason: string) =>
      Effect.fail(
        new FrameSchemaError({ direction, expected: "request", raw, reason }),
      );
    const checked = parseFrameObject(raw);
    if ("reason" in checked) return fail(checked.reason);
    const reason = frameFamilyReason(checked.object);
    return reason === null
      ? Effect.succeed(checked.object as AnyFrame)
      : fail(reason);
  });
}

/**
 * Kinds of malformation the adversity properties inject. Each maps to a
 * deterministic mutation driven by fast-check so shrinks reproduce. Excess-key
 * mutations are absent: the `@effect/rpc` engines strip unknown keys, so an
 * excess key does not malform a frame on the wire.
 */
export type MalformedFrameKind =
  | "bit-flip"
  | "truncated"
  | "invalid-utf8"
  | "missing-required-field";

/**
 * Produce a malformed wire payload from a valid frame. The mutation is
 * deterministic given the `kind` + `seed`; replaying with the same seed
 * reproduces the exact bytes.
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
    case "invalid-utf8":
      return malformInvalidUtf8(rawJson, rand);
    case "missing-required-field":
      return malformMissingRequiredField(rawJson);
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

function malformInvalidUtf8(rawJson: string, rand: () => number): string {
  const pos = Math.floor(rand() * rawJson.length);
  return rawJson.slice(0, pos) + "\uD800" + rawJson.slice(pos);
}

function malformMissingRequiredField(rawJson: string): string {
  return rawJson.replace(/"jsonrpc":"2\.0",?/, "");
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
