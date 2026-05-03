import { Data, Effect } from "effect";
import * as Tracer from "effect/Tracer";

const TRACEPARENT_PART_COUNT = 4;
const VERSION_INDEX = 0;
const TRACE_ID_INDEX = 1;
const SPAN_ID_INDEX = 2;
const FLAGS_INDEX = 3;
const SUPPORTED_VERSION = "00";
const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const FLAGS_LENGTH = 2;
const HEX_RE = /^[0-9a-f]+$/u;
const HEX_RADIX = 16;
const SAMPLED_FLAG = 1;

export interface Traceparent {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
}

export class TraceparentInvalidError extends Data.TaggedError(
  "TraceparentInvalidError",
)<{
  readonly reason:
    | "MalformedString"
    | "UnsupportedVersion"
    | "InvalidTraceId"
    | "InvalidSpanId"
    | "InvalidFlags";
  readonly raw: string;
  readonly message: string;
}> {}

export function parseTraceparent(
  raw: string,
): Effect.Effect<Traceparent, TraceparentInvalidError> {
  const parts = raw.split("-");
  if (parts.length !== TRACEPARENT_PART_COUNT) {
    return invalid("MalformedString", raw, "traceparent must have 4 parts");
  }
  const version = parts[VERSION_INDEX];
  const traceId = parts[TRACE_ID_INDEX];
  const spanId = parts[SPAN_ID_INDEX];
  const flags = parts[FLAGS_INDEX];

  if (version !== SUPPORTED_VERSION) {
    return invalid(
      "UnsupportedVersion",
      raw,
      `Unsupported traceparent version ${version}`,
    );
  }
  if (
    traceId === undefined ||
    traceId.length !== TRACE_ID_LENGTH ||
    !HEX_RE.test(traceId) ||
    traceId === "0".repeat(TRACE_ID_LENGTH)
  ) {
    return invalid("InvalidTraceId", raw, "traceparent trace-id is invalid");
  }
  if (
    spanId === undefined ||
    spanId.length !== SPAN_ID_LENGTH ||
    !HEX_RE.test(spanId) ||
    spanId === "0".repeat(SPAN_ID_LENGTH)
  ) {
    return invalid("InvalidSpanId", raw, "traceparent span-id is invalid");
  }
  if (
    flags === undefined ||
    flags.length !== FLAGS_LENGTH ||
    !HEX_RE.test(flags)
  ) {
    return invalid("InvalidFlags", raw, "traceparent flags are invalid");
  }

  return Effect.succeed({
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, HEX_RADIX),
  });
}

export function formatTraceparent(parent: Traceparent): string {
  return [
    SUPPORTED_VERSION,
    parent.traceId,
    parent.spanId,
    parent.traceFlags.toString(HEX_RADIX).padStart(FLAGS_LENGTH, "0"),
  ].join("-");
}

export function externalParentFromTraceparent(
  raw: string | undefined,
): Effect.Effect<Tracer.AnySpan | undefined, TraceparentInvalidError> {
  if (raw === undefined) return Effect.succeed(undefined);
  return parseTraceparent(raw).pipe(
    Effect.map((traceparent) =>
      Tracer.externalSpan({
        traceId: traceparent.traceId,
        spanId: traceparent.spanId,
        sampled: (traceparent.traceFlags & SAMPLED_FLAG) === SAMPLED_FLAG,
      }),
    ),
  );
}

function invalid(
  reason: TraceparentInvalidError["reason"],
  raw: string,
  message: string,
): Effect.Effect<never, TraceparentInvalidError> {
  return Effect.fail(new TraceparentInvalidError({ reason, raw, message }));
}
