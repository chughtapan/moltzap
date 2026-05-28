/**
 * @file D #705 §7.4 — compile-time canary for the three-arm `Connection`
 * discriminated union and the principal context arms (§1.1, §3.3). These
 * assertions encode the type-level invariants the runtime never re-checks:
 * the nominal brand seal, per-arm `auth` narrowing, and exhaustive
 * `Match.tag` discrimination. A regression in `connection.ts` /
 * `context.ts` surfaces here as a compile error, not at runtime.
 *
 * This file is never executed. Typed `const _x: T = ...` assignments and
 * `@ts-expect-error` directives carry the whole payload; `tsc` fails with
 * TS2578 ("Unused '@ts-expect-error' directive") if a marked line ever
 * stops erroring, so each negative assertion stays load-bearing.
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
import { ServerBootFailedError } from "../app/server.js";

declare const agentConn: AgentConnection;
declare const appConn: AppConnection;
declare const unauthConn: UnauthenticatedConnection;
declare const conn: Connection;

// --- §1.1 per-arm `auth` narrowing -----------------------------------------

// AgentConnection.auth is AgentContext: agentId reads, appId does not.
const _agentAuth: AgentContext = agentConn.auth;
const _agentId: AgentId = _agentAuth.agentId;
// @ts-expect-error - AgentContext has no appId
const _noAppIdOnAgent = agentConn.auth.appId;

// AppConnection.auth is AppContext: appId reads, agentId does not.
const _appAuth: AppContext = appConn.auth;
const _appId = _appAuth.appId;
// @ts-expect-error - AppContext has no agentId
const _noAgentIdOnApp = appConn.auth.agentId;

// UnauthenticatedConnection has no auth field at all.
// @ts-expect-error - the unauthenticated arm carries no auth
const _noAuthOnUnauth = unauthConn.auth;

// --- §3.3 nominal brand seal (structural forgery rejected) ------------------

// An object literal matching the public field shape cannot satisfy any arm —
// the module-private `__brand: never` member is unreachable from outside the
// class declaration (TS2741 missing-property).
declare const forgedBase: {
  readonly _tag: "AgentConnection";
  readonly connId: AgentConnection["connId"];
  readonly socket: AgentConnection["socket"];
  readonly originator: AgentConnection["originator"];
  readonly auth: AgentContext;
};
// @ts-expect-error - structural forgery rejected: missing private __brand
const _forged: AgentConnection = forgedBase;

// --- §1.1 exhaustive Match.tag discrimination -------------------------------

const _principalOf = (c: Connection): "agent" | "app" | "anon" =>
  Match.value(c).pipe(
    Match.tag("AgentConnection", () => "agent" as const),
    Match.tag("AppConnection", () => "app" as const),
    Match.tag("UnauthenticatedConnection", () => "anon" as const),
    Match.exhaustive,
  );
const _principalTag: "agent" | "app" | "anon" = _principalOf(conn);

// --- §3 split-per-arm TransitionOutcome narrows `authed` without a cast ------

declare const outcome: TransitionOutcome;
const _narrowOutcome = (): AgentConnection | AppConnection | null =>
  Match.value(outcome).pipe(
    Match.when({ kind: "not-connected" }, () => null),
    // app/agent arms expose the matching `authed` arm structurally — no cast.
    Match.when({ kind: "ok-agent" }, ({ authed }): AgentConnection => authed),
    Match.when({ kind: "ok-app" }, ({ authed }): AppConnection => authed),
    Match.when({ kind: "already-connected" }, ({ existing }) => existing),
    Match.exhaustive,
  );

// --- §2.7 ServerBootFailedError phase discriminator -------------------------

declare const httpErr: unknown;
const _bootFail: ServerBootFailedError = new ServerBootFailedError({
  phase: "http-listen",
  cause: httpErr,
});
// @ts-expect-error - phase is a closed union; "db" is not a member
const _badPhase = new ServerBootFailedError({ phase: "db", cause: httpErr });

// Reference every binding so no-unused-vars stays quiet; the canary's job is
// the type relationships above, not runtime behavior.
export const _principalCanaryRefs = [
  _agentId,
  _appId,
  _noAppIdOnAgent,
  _noAgentIdOnApp,
  _noAuthOnUnauth,
  _forged,
  _principalTag,
  _narrowOutcome,
  _bootFail,
  _badPhase,
] as const;
