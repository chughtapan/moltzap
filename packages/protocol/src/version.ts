// Auto-bumped by publish workflow
import { Data, Effect } from "effect";

import {
  ProtocolMismatchError,
  type ProtocolMismatchReason,
} from "./network/methods.js";

export const PROTOCOL_VERSION = "2026.529.0";

/**
 * Raised by {@link compareProtocolVersion} (and surfaced through the
 * Effect channel of {@link checkProtocolRange}) when an input string
 * carries a non-numeric or empty segment — e.g., SemVer pre-release
 * suffixes like `2026.527.0-rc.1`, leading/trailing dots like
 * `"2026..0"`, or non-digit characters like `"abc.def"`.
 *
 * **`Data.TaggedError` shape (codex PR review P2 + review-senior P3
 * convergence).** Was a plain `Error` subclass in the first
 * impl-staff drop; switched to `Data.TaggedError` so:
 *
 * - The error flows through Effect's typed `E` channel cleanly
 *   (`Effect.catchTag("InvalidProtocolVersionError", ...)` works in
 *   {@link checkProtocolRange}'s caller).
 * - It matches the sibling {@link ProtocolMismatchError} convention
 *   in `network/methods.ts` (both tagged, both registered if a wire
 *   code is needed).
 *
 * This error is NOT a wire-protocol error — it is INPUT-VALIDATION
 * for untrusted client-supplied version strings. The
 * `network/connect` handler catches it and maps to
 * `InvalidParamsError` (JSON-RPC -32602) so the client gets a typed
 * malformed-input response, not a defect.
 */
export class InvalidProtocolVersionError extends Data.TaggedError(
  "InvalidProtocolVersionError",
)<{ readonly version: string; readonly segment: string }> {
  override get message(): string {
    return `compareProtocolVersion: invalid segment ${JSON.stringify(this.segment)} in ${JSON.stringify(this.version)}`;
  }
}

/**
 * Numeric comparator for `PROTOCOL_VERSION` strings, ordered by their
 * dotted numeric segments (NOT lexicographically).
 *
 * Architect plan #706 v5 (codex r4 P2 #1) — required because CalVer
 * values of the form `YYYY.NNNN.M` carry variable-digit middle
 * components and `"2026.1001.0".localeCompare("2026.527.0") === -1`
 * (lex: `1001 < 527`), opposite of the chronological/numeric truth.
 * The v4 plan's `checkProtocolRange` originally compared
 * `client.maxProtocol < PROTOCOL_VERSION` via raw string ordering;
 * v5 routes it through this helper so the "old client rejected at
 * network/connect" gate stays correct as the publish workflow rolls
 * the middle component past `999`.
 *
 * Returns `-1 | 0 | 1` with conventional semantics:
 *
 *     compareProtocolVersion("2026.527.0",  "2026.527.0")  →  0
 *     compareProtocolVersion("2026.526.0",  "2026.527.0")  → -1
 *     compareProtocolVersion("2026.1001.0", "2026.527.0")  →  1   // numeric, NOT lex
 *     compareProtocolVersion("2025.999.0",  "2026.1.0")    → -1   // year boundary
 *     compareProtocolVersion("2026.527.0",  "2026.527.1")  → -1
 *
 * Each input MUST be a dotted `n.n.n` (or wider) numeric string. The
 * function is intentionally strict — it does NOT accept SemVer
 * pre-release suffixes (`2026.527.0-rc.1`) or build metadata
 * (`2026.527.0+abc`). Empty segments (e.g., `"2026..0"`) and
 * non-digit characters (`"abc"`) also reject — `Number("") === 0`
 * would otherwise silently coerce, contradicting the
 * "strict / fail-closed" JSDoc claim (review-senior P3 #2).
 *
 * **Synchronous throw shape.** Throws
 * {@link InvalidProtocolVersionError} (a `Data.TaggedError`) on any
 * malformed segment. Untrusted client input MUST be funnelled
 * through {@link checkProtocolRange}, which wraps this call in
 * `Effect.try` so the parse error flows through the Effect channel
 * — never as a sync throw escaping into the JSON-RPC handler
 * (codex PR review #1 P2).
 */
export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1 {
  const segmentsA = parseVersionSegments(a);
  const segmentsB = parseVersionSegments(b);
  const len = Math.max(segmentsA.length, segmentsB.length);
  for (let i = 0; i < len; i++) {
    const ai = segmentsA[i] ?? 0;
    const bi = segmentsB[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

// Strict numeric-segment regex: one or more digits, nothing else. Rules
// out empty strings (`Number("") === 0`), whitespace, signs, exponent
// notation, and the SemVer pre-release / build-metadata shapes named
// in the JSDoc. Anchored on both ends.
const NUMERIC_SEGMENT_RE = /^\d+$/;

function parseVersionSegments(version: string): readonly number[] {
  const parts = version.split(".");
  const segments: number[] = [];
  for (const part of parts) {
    if (!NUMERIC_SEGMENT_RE.test(part)) {
      throw new InvalidProtocolVersionError({ version, segment: part });
    }
    segments.push(Number(part));
  }
  return segments;
}

/**
 * Range-check the client's protocol-version interval against an
 * injected server version. Raised by `network/connect` BEFORE auth
 * resolution; the server-side handler in
 * `@moltzap/server-core/identity/handlers/connect.handlers.ts`
 * yields this Effect as the FIRST step of `handleConnect`.
 *
 * **Architect plan #706 v10 (codex r9 P2 #1) — relocated from
 * `connect.handlers.ts` to here.** v9 made the function's signature
 * testable (parameterized over `serverVersion`); v10 makes the
 * function itself importable from `@moltzap/protocol` so regression
 * tests can call it without an illegal test seam through the
 * server-internal handler module.
 *
 * **Two error channels, both typed (codex PR review #1 P2).**
 *
 * - `ProtocolMismatchError` — versions are well-formed, just outside
 *   the supported range. Two `reason` discriminants in the wire
 *   error's `data` field:
 *   - `server-above-client-max` —
 *     `compareProtocolVersion(serverVersion, params.maxProtocol) > 0`.
 *     The server is newer than the client knows how to talk to.
 *   - `server-below-client-min` —
 *     `compareProtocolVersion(serverVersion, params.minProtocol) < 0`.
 *     The client is newer than the server supports.
 * - `InvalidProtocolVersionError` — `params.minProtocol` or
 *   `params.maxProtocol` is not a well-formed numeric version
 *   string. Untrusted client input crosses the boundary here, so
 *   the sync throw in {@link compareProtocolVersion} is wrapped in
 *   `Effect.try` and surfaces as a typed channel error. Callers
 *   (the `network/connect` handler) catch this and map to
 *   `InvalidParamsError` (JSON-RPC `-32602`).
 *
 * Production callers (`handleConnect`) pass the live
 * `PROTOCOL_VERSION` constant; tests inject future-version values
 * to exercise rejection paths against an unbumped branch.
 *
 * Example test usage: `Effect.runSync(Effect.either(checkProtocolRange({
 * minProtocol: "2026.526.0", maxProtocol: "2026.526.0" },
 * "2026.527.0")))` resolves to a `Left` carrying a
 * `ProtocolMismatchError` whose `data.reason` is
 * `"server-above-client-max"`.
 */
export function checkProtocolRange(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  serverVersion: string,
): Effect.Effect<void, ProtocolMismatchError | InvalidProtocolVersionError> {
  // Each `compareProtocolVersion` call may throw
  // `InvalidProtocolVersionError` on malformed
  // `params.{min,max}Protocol` — untrusted client input. Wrapping
  // both calls in `Effect.try` keeps the parse error in the typed E
  // channel; without this, the sync throw would escape into the
  // JSON-RPC dispatch as a defect (codex PR review #1 P2). The
  // `serverVersion` is server-controlled / trusted, but passing it
  // through the same path keeps the symmetry.
  return Effect.gen(function* () {
    const high = yield* compareThrough(serverVersion, params.maxProtocol);
    if (high > 0) {
      return yield* failProtocolMismatch(
        params,
        "server-above-client-max",
        serverVersion,
      );
    }
    const low = yield* compareThrough(serverVersion, params.minProtocol);
    if (low < 0) {
      return yield* failProtocolMismatch(
        params,
        "server-below-client-min",
        serverVersion,
      );
    }
  }).pipe(Effect.withSpan("checkProtocolRange"));
}

/**
 * Effect-wrapped {@link compareProtocolVersion}: routes the sync
 * `InvalidProtocolVersionError` throw into the typed Effect E
 * channel. Module-private; only {@link checkProtocolRange} uses it.
 */
function compareThrough(
  a: string,
  b: string,
): Effect.Effect<-1 | 0 | 1, InvalidProtocolVersionError> {
  return Effect.try({
    try: () => compareProtocolVersion(a, b),
    catch: (cause): InvalidProtocolVersionError => {
      if (cause instanceof InvalidProtocolVersionError) return cause;
      // Defensive: any other throw is a programming defect. Re-raise
      // as a typed error so the channel narrowing holds. Unreachable
      // today (`compareProtocolVersion` only throws
      // `InvalidProtocolVersionError`).
      return new InvalidProtocolVersionError({
        version: `${a} vs ${b}`,
        segment: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
}

/**
 * Construct + raise a {@link ProtocolMismatchError} carrying the
 * diagnostic triple in `data`. Module-private to `version.ts` (NOT
 * exported); callers go through {@link checkProtocolRange}.
 *
 * Architect plan #706 v10 (codex r9 P2 #1) — relocated alongside
 * `checkProtocolRange`. The helper isn't re-exported from the
 * protocol root barrel because its only caller is
 * `checkProtocolRange`; making it private encodes "this is the
 * canonical raise path for ProtocolMismatchError on the server side."
 *
 * The wire error is registered in
 * `@moltzap/protocol/network/methods.ts` with `static code = -32006`
 * and self-registers via `registerErrorClass`. The discriminant
 * `reason` lives in the `data` field per the wire-error convention.
 */
function failProtocolMismatch(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  reason: ProtocolMismatchReason,
  serverVersion: string,
): Effect.Effect<never, ProtocolMismatchError> {
  return Effect.fail(
    new ProtocolMismatchError({
      data: {
        clientMinProtocol: params.minProtocol,
        clientMaxProtocol: params.maxProtocol,
        serverVersion,
        reason,
      },
    }),
  );
}
