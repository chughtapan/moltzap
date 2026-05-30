/**
 * @file Inbound wire-decode hot-path benchmark — perf canary for the
 * dispatcher's per-frame decode cost.
 *
 * WHAT THIS GUARDS
 * ----------------
 * Every inbound JSON-RPC request the server accepts pays a fixed decode
 * tax before any handler runs. That tax is two stages, both measured here
 * against the REAL shipping schemas (no toy schemas):
 *
 *   1. `decodeFrame` — the 3-arm envelope classifier in `wire.ts`. It runs
 *      the compiled AJV `validateRequestFrame` -> `validateResponseFrame` ->
 *      `validateNotificationFrame` guards in order until one matches.
 *   2. `decodeRpcRequest` — the per-method selection + params validation in
 *      `rpc-groups.ts`. It linear-scans the ~34-method `serverRpcMethods`
 *      catalog (`.find(d => d.name === frame.method)`) then runs that
 *      method's compiled AJV `validateParams`.
 *
 * The full inbound decode a request frame pays is `decodeFrame` +
 * `decodeRpcRequest` composed. This file measures that full path, isolated
 * from socket I/O and JSON parsing (frames are pre-parsed plain objects),
 * across three representative frame classes:
 *
 *   - small:   `agents/list`               (1 optional integer param)
 *   - typical: `messages/send`             (4 branded-UUID + 1 text-part array)
 *   - nested:  `task/conversation/create`  (branded UUID + participants[] array)
 *
 * The fixtures' validity (both engines ACCEPT all three frames) is asserted
 * in the sibling `frames.test.ts` so this file stays a pure timing harness —
 * a bench that silently times a rejection path would be worthless, and that
 * test fails loudly if a schema drifts out from under the fixtures.
 *
 * WHY IT EXISTS (de-risks #723)
 * -----------------------------
 * #723 migrates wire validation from TypeBox+AJV (compiled validators) to
 * `effect/Schema` (AST-interpreted decode). The #720 spike flagged per-frame
 * `Schema.decode` cost as the one UNPROVEN risk on this hot path. This
 * benchmark is BOTH:
 *   (a) the AJV baseline the migration must not regress — a standing perf
 *       canary on the decode hot path, useful regardless of #723; and
 *   (b) a side-by-side A/B against an `effect/Schema` PROTOTYPE built in the
 *       exact shape the migration would ship (a `Schema.Union` of per-method
 *       structs discriminated on the `method` literal, decoded via
 *       `Schema.decodeUnknownEither` with `onExcessProperty: "error"` to match
 *       AJV `strict` + `additionalProperties: false`).
 *
 * The Effect-Schema prototype is bench-only spike code — clearly fenced in
 * `./effect-schema-prototype.ts`, imported here ONLY for the A/B variants.
 * It ships no production surface and is not on any barrel.
 *
 * RUN
 * ---
 * From the protocol package: `pnpm bench` (or, from the repo root,
 * `pnpm --filter ./packages/protocol bench`).
 */
import { bench, describe } from "vitest";
import { Effect } from "effect";
import type { RequestFrame } from "../wire.js";
import {
  smallFrame,
  typicalFrame,
  nestedFrame,
  decodeAjvFull,
  selectAjvMethod,
} from "./frames.js";
import {
  decodeWireRequest,
  selectMethodArm,
} from "./effect-schema-prototype.js";

// ── (1) FULL inbound decode: decodeFrame + decodeRpcRequest ──────────
// This is the tax every accepted request frame pays. AJV path runs the
// real shipping `decodeFrame` (3-arm envelope) + `decodeRpcRequest`
// (linear find + per-method validateParams) over the real
// `serverRpcMethods` catalog. Schema path runs the single-pass union
// decode that subsumes all three.

describe("full inbound decode — AJV (shipping path)", () => {
  bench("small  · agents/list", () => {
    Effect.runSyncExit(decodeAjvFull(smallFrame as RequestFrame));
  });
  bench("typical · messages/send", () => {
    Effect.runSyncExit(decodeAjvFull(typicalFrame as RequestFrame));
  });
  bench("nested · task/conversation/create", () => {
    Effect.runSyncExit(decodeAjvFull(nestedFrame as RequestFrame));
  });
});

describe("full inbound decode — Effect Schema (prototype)", () => {
  bench("small  · agents/list", () => {
    decodeWireRequest(smallFrame);
  });
  bench("typical · messages/send", () => {
    decodeWireRequest(typicalFrame);
  });
  bench("nested · task/conversation/create", () => {
    decodeWireRequest(nestedFrame);
  });
});

// ── (2) METHOD-SELECTION cost over the ~34-method catalog ────────────
// AJV: the linear `.find()` scan + the matched method's validateParams.
// Schema: the discriminated-union arm select (same union decode, isolated
// to the selection+params cost). We measure the `messages/send` / nested
// cases which sit mid/late in the catalog.

describe("method-selection — AJV linear find + validateParams", () => {
  bench("typical · messages/send", () => {
    selectAjvMethod(typicalFrame as RequestFrame);
  });
  bench("nested · task/conversation/create", () => {
    selectAjvMethod(nestedFrame as RequestFrame);
  });
});

describe("method-selection — Effect Schema union arm-select", () => {
  bench("typical · messages/send", () => {
    selectMethodArm(typicalFrame);
  });
  bench("nested · task/conversation/create", () => {
    selectMethodArm(nestedFrame);
  });
});
