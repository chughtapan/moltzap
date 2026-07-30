/**
 * @file Compile-time canary for the three-arm `Connection` discriminated union
 * and the principal context arms. These assertions encode the type-level
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
  AppConnection,
  Connection,
  TransitionOutcome,
  UnauthenticatedConnection,
} from "./connection.js";
import type { AgentContext, AppContext } from "./context.js";
import type { AgentId } from "@moltzap/protocol/identity";
import { ServerBootFailedError } from "#core";

declare const agentConn: AgentConnection;
declare const appConn: AppConnection;
declare const conn: Connection;

// --- per-arm `auth` narrowing -----------------------------------------

type ExpectFalse<Value extends false> = Value;

// AgentConnection.auth is AgentContext: agentId reads and appId is absent.
const agentAuth: AgentContext = agentConn.auth;
const agentIdValue: AgentId = agentAuth.agentId;
type AgentHasNoAppId = ExpectFalse<
  "appId" extends keyof AgentConnection["auth"] ? true : false
>;

// AppConnection.auth is AppContext: appId reads and agentId is absent.
const appAuth: AppContext = appConn.auth;
const appIdValue = appAuth.appId;
type AppHasNoAgentId = ExpectFalse<
  "agentId" extends keyof AppConnection["auth"] ? true : false
>;
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
  readonly socket: AgentConnection["socket"];
  readonly originator: AgentConnection["originator"];
  readonly auth: AgentContext;
}
type ForgedAgentRejected = ExpectFalse<
  ForgedBase extends AgentConnection ? true : false
>;

// --- exhaustive Match.tag discrimination -------------------------------

const principalOf = (c: Connection): "agent" | "app" | "anon" =>
  Match.value(c).pipe(
    Match.tag("AgentConnection", () => "agent" as const),
    Match.tag("AppConnection", () => "app" as const),
    Match.tag("UnauthenticatedConnection", () => "anon" as const),
    Match.exhaustive,
  );
const principalTag: "agent" | "app" | "anon" = principalOf(conn);

// --- split-per-arm TransitionOutcome narrows `authed` without a cast ------

declare const outcome: TransitionOutcome;
const narrowOutcome = (): AgentConnection | AppConnection | null =>
  Match.value(outcome).pipe(
    Match.when({ kind: "not-connected" }, () => null),
    // app/agent arms expose the matching `authed` arm structurally — no cast.
    Match.when({ kind: "ok-agent" }, ({ authed }): AgentConnection => authed),
    Match.when({ kind: "ok-app" }, ({ authed }): AppConnection => authed),
    Match.when({ kind: "already-connected" }, ({ existing }) => existing),
    Match.exhaustive,
  );

// --- ServerBootFailedError phase discriminator -------------------------

declare const httpErr: unknown;
const bootFail: ServerBootFailedError = new ServerBootFailedError({
  phase: "http-listen",
  cause: httpErr,
});
type InvalidBootPhaseRejected = ExpectFalse<
  "db" extends ServerBootFailedError["phase"] ? true : false
>;

/** Compile-time assertions for the principal and boot-failure boundaries. */
export type PrincipalBoundaryCanaries = [
  AgentHasNoAppId,
  AppHasNoAgentId,
  UnauthenticatedHasNoAuth,
  ForgedAgentRejected,
  InvalidBootPhaseRejected,
];

// Reference every binding so no-unused-vars stays quiet; the canary's job is
// the type relationships above, not runtime behavior.
/** Provides the principal canary refs runtime value. */
export const principalCanaryRefs: readonly unknown[] = [
  agentIdValue,
  appIdValue,
  principalTag,
  narrowOutcome,
  bootFail,
] as const;
