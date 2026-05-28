// Auto-bumped by publish workflow
import { Effect } from "effect";

import {
  ProtocolMismatchError,
  type ProtocolMismatchReason,
} from "./network/methods.js";

export const PROTOCOL_VERSION = "2026.526.0";

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
 * (`2026.527.0+abc`). MoltZap's `PROTOCOL_VERSION` has never carried
 * those; impl-staff fails closed at parse-time if it sees a non-numeric
 * segment (regression test enumerated in the architect plan §8).
 *
 * Stub: impl-staff fills the body per architect SKILL.md.
 */
export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1 {
  /* eslint-disable sonarjs/void-use -- architect stub: `void X;` references keep the named parameters reachable until impl-staff fills the body (mirrors the moltzap convention). */
  void a;
  void b;
  /* eslint-enable sonarjs/void-use -- restore the rule outside the stub-body region. */
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
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
 * Two reasons (mutually exclusive — the discriminator is in the
 * wire-error `data.reason` field):
 *
 * - `server-above-client-max` —
 *   `compareProtocolVersion(serverVersion, params.maxProtocol) > 0`.
 *   The server is newer than the client knows how to talk to.
 * - `server-below-client-min` —
 *   `compareProtocolVersion(serverVersion, params.minProtocol) < 0`.
 *   The client is newer than the server supports.
 *
 * Architect lands the real body — it's a small typed branch.
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
): Effect.Effect<void, ProtocolMismatchError> {
  // sonarjs/no-use-of-empty-return-value fires because the
  // architect-stub `compareProtocolVersion` body throws synchronously
  // so its inferred return is `never`. Once impl-staff lands the body
  // returning `-1 | 0 | 1`, the rule is satisfied automatically. The
  // disable is scoped to the two call sites that consume the helper.
  /* eslint-disable sonarjs/no-use-of-empty-return-value -- architect-stub call site; impl-staff replaces `compareProtocolVersion`'s throw with the real `-1 | 0 | 1` body. */
  if (compareProtocolVersion(serverVersion, params.maxProtocol) > 0) {
    return failProtocolMismatch(
      params,
      "server-above-client-max",
      serverVersion,
    );
  }
  if (compareProtocolVersion(serverVersion, params.minProtocol) < 0) {
    return failProtocolMismatch(
      params,
      "server-below-client-min",
      serverVersion,
    );
  }
  /* eslint-enable sonarjs/no-use-of-empty-return-value -- restore the rule outside the stub-body region. */
  return Effect.void;
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
