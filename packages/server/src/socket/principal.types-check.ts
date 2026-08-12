/**
 * @file Compile-time canary for the two-arm `Connection` discriminated union
 * and the agent principal context. These assertions encode the type-level
 * invariants the runtime never re-checks: the nominal brand boundary, per-arm
 * `auth` narrowing, and exhaustive `Match.tag` discrimination. A regression in
 * `connection.ts` / `context.ts` surfaces here as a compile error, not at
 * runtime.
 *
 * This file is never executed. Positive assignments and conditional-type
 * assertions carry the payload without suppressing compiler diagnostics.
 */
import { Match } from "effect";
import type {
  AgentConnection,
  Connection,
  TransitionOutcome,
  UnauthenticatedConnection,
} from "./connection.js";
import type { AgentContext } from "./context.js";
import type { AgentId } from "@moltzap/protocol/identity";

declare const agentConn: AgentConnection;
declare const conn: Connection;

// --- per-arm `auth` narrowing -----------------------------------------

type ExpectFalse<Value extends false> = Value;

// AgentConnection.auth is AgentContext: agentId reads off the authed arm.
const agentAuth: AgentContext = agentConn.auth;
const agentIdValue: AgentId = agentAuth.agentId;
type UnauthenticatedHasNoAuth = ExpectFalse<
  "auth" extends keyof UnauthenticatedConnection ? true : false
>;

// --- nominal brand boundary (structural forgery rejected) --------------

// An object literal matching the public field shape cannot satisfy any arm —
// the module-private `__brand: never` member is unreachable from outside the
// class declaration (TS2741 missing-property).
interface ForgedBase {
  readonly _tag: "AgentConnection";
  readonly connId: AgentConnection["connId"];
  readonly originator: AgentConnection["originator"];
  readonly auth: AgentContext;
}
type ForgedAgentRejected = ExpectFalse<
  ForgedBase extends AgentConnection ? true : false
>;

// --- exhaustive Match.tag discrimination -------------------------------

const principalOf = (c: Connection): "agent" | "anon" =>
  Match.value(c).pipe(
    Match.tag("AgentConnection", () => "agent" as const),
    Match.tag("UnauthenticatedConnection", () => "anon" as const),
    Match.exhaustive,
  );
const principalTag: "agent" | "anon" = principalOf(conn);

// --- TransitionOutcome narrows `authed` without a cast ------------------

declare const outcome: TransitionOutcome;
const narrowOutcome = (): AgentConnection | null =>
  Match.value(outcome).pipe(
    Match.when({ kind: "not-connected" }, () => null),
    // The success arm exposes `authed` structurally — no cast.
    Match.when({ kind: "ok-agent" }, ({ authed }): AgentConnection => authed),
    Match.when({ kind: "already-connected" }, ({ existing }) => existing),
    Match.exhaustive,
  );

/** Compile-time assertions for the principal boundaries. */
export type PrincipalBoundaryCanaries = [
  UnauthenticatedHasNoAuth,
  ForgedAgentRejected,
];

// Reference every binding so no-unused-vars stays quiet; the canary's job is
// the type relationships above, not runtime behavior.
/** Provides the principal canary refs runtime value. */
export const principalCanaryRefs: readonly unknown[] = [
  agentIdValue,
  principalTag,
  narrowOutcome,
] as const;
