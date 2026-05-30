/**
 * @file Type canaries for the #705 HALF-2 slice-1 middleware-slot path
 * (`defineTaskMiddlewareMethod` + `CapabilityMiddleware` + `CurrentPrincipal`).
 *
 * Locks in the cast-free TOTALITY lockstep on the LIVE binding the server
 * builds. Negative cases use `@ts-expect-error` — `tsc --build` fails with
 * TS2578 ("Unused '@ts-expect-error' directive") if a marked line ever
 * stops erroring, so the protection can't silently regress.
 *
 * The trap this set is authored to catch (the type-invisible bug found at
 * slice impl): a method whose HANDLER does not itself `yield*` the cap
 * (`messages/list` — its `TaskReadAccess`/`ConversationInTask` are auth
 * side-effects, not consumed services). The legacy positional `CapProviders`
 * tuple guarded totality there; the middleware path replaces it with the
 * `CapIdents`-pinned-from-tuple + widened-`weaveCaps`-input bound. If that
 * bound were vacuous, DROPPING a `provideServiceEffect` from `weaveCaps`
 * would compile (silently dropping an auth check). Canary M2 proves it does
 * NOT compile.
 */

import { Effect } from "effect";
import {
  CurrentPrincipal,
  MessagesList,
  provideMiddleware,
  type ParamsOf,
} from "@moltzap/protocol";
import { defineTaskMiddlewareMethod } from "./define-layered-method.js";
import type { ServerRpcSlots } from "./context.js";
import { MessageServiceTag } from "../app/layers.js";
import {
  conversationInTaskForList,
  taskReadAccessMiddleware,
} from "../app/capability-middlewares.js";

type MessagesListParams = ParamsOf<typeof MessagesList>;

// A `messages/list`-shaped handler that consumes NEITHER declared cap — its
// `TaskReadAccess`/`ConversationInTask` are auth side-effects, the
// false-green trap shape (handler R holds no cap ident).
const listHandler = (
  _params: MessagesListParams,
): Effect.Effect<
  { readonly messages: never[]; readonly hasMore: boolean },
  never,
  MessageServiceTag
> =>
  Effect.gen(function* () {
    yield* MessageServiceTag;
    return { messages: [], hasMore: false };
  });

// ── Canary M1 (positive): `weaveCaps` discharges BOTH declared caps →
// compiles; the slot stores in `ServerRpcSlots` (residual R = TaskSlotEnv).
// ───────────────────────────────────────────────────────────────────────

const _okSlot = defineTaskMiddlewareMethod(
  MessagesList,
  [taskReadAccessMiddleware, conversationInTaskForList] as const,
  {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: listHandler,
    weaveCaps: (handlerEffect, params) =>
      handlerEffect.pipe(
        provideMiddleware(conversationInTaskForList, params),
        provideMiddleware(taskReadAccessMiddleware, params),
      ),
  },
);

// ── Canary M2 (negative — THE load-bearing one): `weaveCaps` discharges
// only ONE of the two declared caps. `TaskReadAccess` leaks into the woven
// R and fails the totality bound — EVEN THOUGH the handler consumes neither
// cap. This is the guarantee the legacy `CapProviders` tuple gave and the
// "compiler-native handler-R lockstep" alone did NOT (handler R has no cap).
// Proves `provideMiddleware` preserves non-vacuity.
// ───────────────────────────────────────────────────────────────────────

const _undischarged = defineTaskMiddlewareMethod(
  MessagesList,
  [taskReadAccessMiddleware, conversationInTaskForList] as const,
  {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: listHandler,
    weaveCaps: (handlerEffect, params) =>
      // @ts-expect-error — only ConversationInTask discharged; TaskReadAccess leaks into the woven R, fails the totality bound (non-vacuous).
      handlerEffect.pipe(
        provideMiddleware(conversationInTaskForList, params),
        // TaskReadAccess intentionally NOT provided.
      ),
  },
);

// ── Canary M3 (implNeed #2 — heterogeneous registry, no widen): a
// middleware slot stores in the SAME `ServerRpcSlotTable` as a legacy
// erased slot. `_okSlot` is the exact `ServerRpcSlots` element type — caps +
// principal + connection all discharged INSIDE the body, so `invoke`'s
// residual R bottomed out at `TaskSlotEnv` (had any tag leaked, the slot's
// `Env` would differ and this assignment would fail). No widening cast. ────

const _registrySink: ServerRpcSlots = [_okSlot];

export type _MiddlewareSlotCanarySink =
  | typeof _okSlot
  | typeof _undischarged
  | typeof _registrySink
  | typeof CurrentPrincipal;
