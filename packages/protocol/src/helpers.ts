import {
  FormatRegistry,
  Type,
  type TString,
  type TSchema,
} from "@sinclair/typebox";
import { JSON_RPC_VERSION, type JsonRpcId } from "./schema/json-rpc.js";
import type {
  NotificationFrame,
  RequestFrame,
  ResponseFrame,
} from "./schema/frames.js";
import type { JsonRpcStringId } from "./schema/json-rpc.js";
import type {
  NotificationDefinition,
  NotificationParamsOf,
} from "./notification.js";
import type { ParamsOf, RpcDefinition } from "./rpc.js";
import {
  brandNotificationFrame,
  brandRequestFrame,
  brandResponseFrame,
} from "./schema/internal-frames.js";
export {
  brandedNumber,
  brandedString,
  type BrandedNumber,
  type BrandedString,
} from "./brands.js";
import { brandedString } from "./brands.js";

/**
 * Register the string formats this protocol uses with TypeBox's
 * `FormatRegistry` as a side effect at module load. Without this,
 * `Value.Decode` against any schema that uses `format: "uuid"` (and friends)
 * fails with `Unknown format uuid` and every frame is rejected — see #370.
 *
 * Registering here makes downstream consumers correct by construction:
 * importing anything from `@moltzap/protocol` registers the formats, even
 * via dynamic-import paths that never reach a bin entrypoint.
 *
 * `FormatRegistry` is a process-global, so we gate on `Has(...)` to avoid
 * clobbering a consumer-provided stricter validator that ran before us.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shape filter for RFC 3339 / ISO 8601. We pair it with `Date.parse` so
// values like "2026-99-99T99:99:99Z" — shape-valid but semantically
// impossible — also reject.
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Liberal URI matcher: scheme + ":" + non-whitespace remainder. Tighter
// validation (e.g., authority parsing) lives in the consumer if needed.
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set(
    "uuid",
    (value) => typeof value === "string" && UUID_RE.test(value),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false;
    return Number.isFinite(Date.parse(value));
  });
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set(
    "uri",
    (value) => typeof value === "string" && URI_RE.test(value),
  );
}

/**
 * Creates a string enum schema without producing anyOf (which some validators reject).
 * Uses Type.String + enum constraint (Kind="String") so TypeBox's Value.Decode
 * visitor handles the node — Type.Unsafe has no Kind tag and trips
 * `ValueCheckUnknownTypeError: Unknown type` on consumer-side decoders.
 * Matches OpenClaw's stringEnum pattern.
 */
export function stringEnum<T extends string[]>(values: [...T]) {
  return Type.String({ enum: values }) as TString & { static: T[number] };
}

/**
 * Branded UUID string type for TypeBox schemas.
 * Usage: brandedId("UserId") produces a string schema with format: "uuid"
 */
export function brandedId<const BrandName extends string>(brand: BrandName) {
  return brandedString(brand, {
    format: "uuid",
    description: `Branded ${brand}`,
  });
}

/**
 * ISO 8601 datetime string schema.
 */
export const DateTimeString = Type.String({ format: "date-time" });

/**
 * Construct a typed JSON-RPC notification from a notification descriptor.
 * Production code should pass descriptors, not raw method names.
 */
export function notificationFrame<
  D extends NotificationDefinition<string, TSchema>,
>(
  definition: D,
  params: NotificationParamsOf<D>,
): NotificationFrame & {
  readonly method: D["name"];
  readonly params: NotificationParamsOf<D>;
} {
  return brandNotificationFrame({
    jsonrpc: JSON_RPC_VERSION,
    method: definition.name,
    params,
  });
}

/**
 * Construct a JSON-RPC Request object. This is the single public helper for
 * request frame construction; callers should pass a descriptor-backed method,
 * not hand-write frame object literals.
 */
export function requestFrame<D extends RpcDefinition<string, TSchema, TSchema>>(
  id: JsonRpcStringId,
  definition: D,
  params: ParamsOf<D>,
): RequestFrame & {
  readonly method: D["name"];
  readonly params: ParamsOf<D>;
} {
  return brandRequestFrame({
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: definition.name,
    params,
  });
}

/**
 * Construct a typed JSON-RPC Response object. Pass `{ result }` for success
 * or `{ error }` for failure; exactly one body branch is present.
 *
 * Parse errors whose id is unknown should be written directly with `id: null`;
 * normal replies use the string id minted by the matching request.
 */
export type ResponseFrameError = {
  code: number;
  message: string;
  data?: unknown;
};
export type ResponseFrameBody =
  | { result: unknown }
  | { error: ResponseFrameError };

export function responseFrame(
  id: JsonRpcId,
  body: ResponseFrameBody,
): ResponseFrame {
  return brandResponseFrame({
    jsonrpc: JSON_RPC_VERSION,
    id,
    ...body,
  });
}
