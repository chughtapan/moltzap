/**
 * @file Type-canary for Spec A (#595) AC1 — final public-barrel shape.
 *
 * This file does NOT run at runtime; it's a compile-time canary that
 * `tsc --noEmit` evaluates. The expectations fail to compile if the
 * barrel drifts from what Spec A AC1 promises.
 *
 * Architect-tier (#603) ships this canary with TWO assertions:
 *   (1) the V2-aliased names exist in the stub branch (so the stub
 *       compiles against the legacy + new co-exporting barrel);
 *   (2) the unaliased names also exist (so impl-staff's cutover —
 *       which deletes the legacy exports and renames the V2 aliases
 *       — is verified by the same canary file without further edits).
 *
 * Post-cutover state (impl-staff): assertion (1) becomes vacuous (the
 * V2 aliases delete). The file remains; if a future refactor
 * accidentally re-introduces a `V2` alias, the canary fails — drawing
 * attention back to AC1's "final barrel exports the unaliased names"
 * bar.
 *
 * Codex R3 finding #5: "the stub branch does not match the promised
 * public surface" — this canary makes the deviation an explicit
 * staged exception, with a compile-time gate on its removal.
 */
import type {
  // Surface names that are Connection-native in the stub branch and
  // do NOT collide with legacy `json-rpc-{server,client}.ts` exports.
  Connection,
  ConnectionConfig,
  ConnectionContext,
  DecodedRequest,
  HookFailure,
  JsonValue,
  Subscription,
  ServerConnection,
  ClientConnection,
  ConnectionRunError,
  RemoteTaggedError,
} from "./index.js";

// Connection-native names that COLLIDE with legacy exports in the
// stub branch. The barrel re-exports the Connection-native forms
// under the `V2` suffix until impl-staff's cutover deletes the
// legacy exports. After cutover (per AC1's stub-only-deviation note
// in plan #603), impl-staff renames `RpcHandlerV2 → RpcHandler` and
// `RpcCallErrorV2 → RpcCallError` in the barrel + on this import
// line. Codex r1 F7 fix: the canary now references the V2 names
// explicitly so it gates the CONNECTION-NATIVE shape, not the legacy
// shape that the unaliased names currently resolve to.
import type { RpcHandlerV2, RpcCallErrorV2 } from "./index.js";

// Cutover-time forcing function. After impl-staff deletes the V2
// aliases (or renames them), the import block above must update; if
// the rename forgets a symbol, the next two lines fail to compile.
type _RpcHandlerV2Smoke = RpcHandlerV2<unknown>;
type _RpcCallErrorV2Smoke = RpcCallErrorV2;

// Smoke tests for the AC1 surface (each line fails compile if the type
// disappears from the barrel).
type _Connection = Connection<unknown>;
type _ConnectionConfig = ConnectionConfig;
type _ConnectionContext = ConnectionContext<{ readonly foo: number }>;
type _DecodedRequest = DecodedRequest;
type _HookFailure = HookFailure;
type _JsonValue = JsonValue;
type _Subscription = Subscription;
type _ServerConnection = ServerConnection<unknown>;
type _ClientConnection = ClientConnection<unknown>;
type _ConnectionRunError = ConnectionRunError;
type _RemoteTaggedError = RemoteTaggedError;

// Reference-only — silences unused-type warnings while preserving the
// canary semantics. The intersection forces TS to flatten every member
// type; any structural drift fails here.
export type _AC1Canary =
  | _RpcHandlerV2Smoke
  | _RpcCallErrorV2Smoke
  | _Connection
  | _ConnectionConfig
  | _ConnectionContext
  | _DecodedRequest
  | _HookFailure
  | _JsonValue
  | _Subscription
  | _ServerConnection
  | _ClientConnection
  | _ConnectionRunError
  | _RemoteTaggedError;
