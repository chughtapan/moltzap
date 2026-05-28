/* eslint-disable sonarjs/void-use -- type-canary uses `void X;` to mark const-asserted shapes consumed (mirrors the moltzap convention). */
/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `<` / `>` comparison operators in prose; escaping would render them as escape codes. */

/**
 * Type-canary for the protocol-version surface (architect plan #706 v6).
 *
 * Asserts:
 *
 * 1. **`PROTOCOL_VERSION` is a string literal.** The publish workflow
 *    bumps this constant; the architect plan §7 requires it to be a
 *    dotted CalVer string. Type-level assertion only — the runtime
 *    shape is `n.n.n`, enforced by `compareProtocolVersion`'s parser
 *    when impl-staff fills the body.
 *
 * 2. **`compareProtocolVersion(a, b)` has the signature
 *    `(string, string) => -1 | 0 | 1`.** Architect plan #706 v5 (codex
 *    r4 P2 #1). Required because CalVer values with variable-digit
 *    components (e.g. `2026.1001.0` vs `2026.527.0`) are NOT
 *    lex-sortable; `checkProtocolRange` in the connect handler MUST
 *    use this helper, not `<`/`>` on the raw strings. The literal
 *    triple-return type is the canary: a future contributor who
 *    relaxes the return to `number` will hit the assertion below.
 *
 * **v6 (plan-eng r5 P3 fix).** Switched from `void (x as T)` to
 * `const _check: T = x; void _check;`. The `as` operator allows
 * bidirectional widening between assignable types — relaxing
 * `compareProtocolVersion`'s return from `-1 | 0 | 1` to `number`
 * did NOT fail tsc with the `as` form. Direct annotation triggers
 * TS2322 on widening. Empirically verified: changing the comparator
 * return to `number` now fires the canary.
 *
 * No test-runner involvement; `tsc --noEmit` is the canary.
 */

import { PROTOCOL_VERSION, compareProtocolVersion } from "./version.js";

declare const versionTypeCheck: typeof PROTOCOL_VERSION;
const _versionTypeCheckCheck: string = versionTypeCheck;
void _versionTypeCheckCheck;

declare const compareTypeCheck: typeof compareProtocolVersion;
const _compareTypeCheckCheck: (a: string, b: string) => -1 | 0 | 1 =
  compareTypeCheck;
void _compareTypeCheckCheck;
