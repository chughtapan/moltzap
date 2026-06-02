/**
 * @file Type canaries for the per-capability `@effect/rpc` middlewares
 * (`transport/cap-middlewares.ts`).
 *
 * Each capability is its own `RpcMiddleware.Tag`, stacked on a method via
 * chainable `Rpc.middleware(...)`. These pin the invariants the server's
 * per-cap middleware Layers and the engine binding depend on:
 *
 *   mw.provides   a cap middleware `provides` its capability `Context.Tag`, so
 *                 the handler reads that exact cap value off context.
 *   mw.gate       the principal gate has NO `provides` (a pure gate) and is
 *                 non-optional (an optional middleware falls through to the
 *                 handler on failure, letting a rejected principal reach the
 *                 body — a security hole).
 *   mw.failure    a cap middleware's `failure` is its capability's own error
 *                 union, so the engine unions it into the method's wire error.
 */
import { Schema } from "effect";
import {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
} from "./cap-middlewares.js";
import {
  ConversationInTask,
  ConversationSendAccess,
} from "../task/capabilities/index.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

// ── mw.provides — a cap middleware provides its capability Tag ────────────

type _CitProvides = Expect<
  Equal<(typeof ConversationInTaskMw)["provides"], typeof ConversationInTask>
>;
type _CsaProvides = Expect<
  Equal<
    (typeof ConversationSendAccessMw)["provides"],
    typeof ConversationSendAccess
  >
>;

// ── mw.gate — the principal gate provides nothing, non-optional ───────────

// A gate-only middleware carries no `provides` (`undefined`).
type _GateNoProvides = Expect<
  Equal<(typeof PrincipalGateMw)["provides"], undefined>
>;
// Every cap/gate middleware is non-optional (hard-fails the frame).
type _GateNonOptional = Expect<
  Equal<(typeof PrincipalGateMw)["optional"], false>
>;
type _CitNonOptional = Expect<
  Equal<(typeof ConversationInTaskMw)["optional"], false>
>;

// ── mw.failure — a cap middleware's failure is a real Schema (non-never) ──

// `ConversationSendAccess` declares `ForbiddenError`, so its middleware's
// `failure` is a concrete Schema (not the `Schema.Never` default), which the
// engine unions into `messages/send`'s wire error.
type _CsaFailureNotNever = Expect<
  Equal<
    (typeof ConversationSendAccessMw)["failure"] extends typeof Schema.Never
      ? true
      : false,
    false
  >
>;

export type {
  _CitProvides,
  _CsaProvides,
  _GateNoProvides,
  _GateNonOptional,
  _CitNonOptional,
  _CsaFailureNotNever,
};
