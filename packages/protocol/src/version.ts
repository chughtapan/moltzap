// Auto-bumped by publish workflow
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
