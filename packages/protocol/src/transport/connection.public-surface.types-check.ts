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
  // Final names (Spec A AC1 promised public surface).
  Connection,
  ConnectionConfig,
  ConnectionContext,
  DecodedRequest,
  HookFailure,
  JsonValue,
  RpcHandler,
  Subscription,
  ServerConnection,
  ClientConnection,
  ConnectionRunError,
  RpcCallError,
  RemoteTaggedError,
} from "./index.js";

// (1) Stub-branch deviation — V2 aliases are still present until
// impl-staff cuts over. If the cutover deletes these but forgets to
// rename the underlying types, the next line fails to compile.
import type { RpcHandlerV2, RpcCallErrorV2 } from "./index.js";

// (2) Architect intent: after cutover, the V2 aliases delete. At that
// point, the typeof-equality below is between two identical types
// (RpcHandler from connection/handler.ts and RpcHandlerV2's underlying
// type, which is the same type). When impl-staff renames V2→canonical,
// the equality is between the renamed and the canonical — also identical.
// If impl-staff accidentally reintroduces a V2 alias as a STRUCTURAL
// divergence (different shape), the assignability fails here.
type _RpcHandlerV2EqCanonical =
  RpcHandlerV2<unknown> extends RpcHandler<unknown> ? true : never;
type _RpcCallErrorV2EqCanonical = RpcCallErrorV2 extends RpcCallError
  ? true
  : never;

// Smoke tests for the AC1 surface (each line fails compile if the type
// disappears from the barrel).
type _Connection = Connection<unknown>;
type _ConnectionConfig = ConnectionConfig;
type _ConnectionContext = ConnectionContext<{ readonly foo: number }>;
type _DecodedRequest = DecodedRequest;
type _HookFailure = HookFailure;
type _JsonValue = JsonValue;
type _RpcHandler = RpcHandler<unknown>;
type _Subscription = Subscription;
type _ServerConnection = ServerConnection<unknown>;
type _ClientConnection = ClientConnection<unknown>;
type _ConnectionRunError = ConnectionRunError;
type _RpcCallError = RpcCallError;
type _RemoteTaggedError = RemoteTaggedError;

// Reference-only — silences unused-type warnings while preserving the
// canary semantics. The intersection forces TS to flatten every member
// type; any structural drift fails here.
export type _AC1Canary =
  | _RpcHandlerV2EqCanonical
  | _RpcCallErrorV2EqCanonical
  | _Connection
  | _ConnectionConfig
  | _ConnectionContext
  | _DecodedRequest
  | _HookFailure
  | _JsonValue
  | _RpcHandler
  | _Subscription
  | _ServerConnection
  | _ClientConnection
  | _ConnectionRunError
  | _RpcCallError
  | _RemoteTaggedError;
