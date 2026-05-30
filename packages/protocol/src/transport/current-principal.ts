/**
 * @file `CurrentPrincipal` — the request's authenticated principal as a
 * first-class Effect Context service (#705 HALF-2, principal-as-service).
 *
 * The capability middleware reads the caller's identity NOT from a `ctx`
 * parameter threaded through the descriptor surface, but as a SERVICE it
 * `yield*`s. `CurrentPrincipal` is a protocol-owned `Context.Tag` whose
 * value is the 2-arm authenticated principal; the server SATISFIES it with
 * `provideService(CurrentPrincipal, arm)` at the dispatch site, from the
 * same narrowed arm the #720 principal-kind gate already computed.
 *
 * This is the same protocol-owned / server-satisfied split the four
 * capability tags (`TaskReadAccess`, `ConversationInTask`, …) already use:
 * the protocol declares the Tag + value type; the server provides the
 * value. The one-way protocol→server edge is preserved (protocol never
 * imports the server).
 *
 * HALF-2 slice-1 (this file): provides `CurrentPrincipal` only for the
 * middleware-converted methods (`messages/send`, `messages/list`). The
 * unauth Connect path (`network/connect`, `callablePrincipal: "any"`)
 * declares zero middlewares, so nothing `yield*`s `CurrentPrincipal`
 * there and it is never provided on the unauthenticated arm.
 */
import { Context, Effect } from "effect";
import type { AgentId } from "../identity/agents.js";
import type { AppId } from "../task/ids.js";

/**
 * The authenticated principal of the in-flight request — the value a
 * capability middleware `yield*`s to read `agentId` / `appId`. Tagged so a
 * middleware narrows the app-arm vs agent-arm by discriminant before
 * reading the field (no `as { agentId }` assertion).
 *
 * The server's `AgentContext` / `AppContext`
 * (`@moltzap/server-core` `transport/context.ts`) — `Data.TaggedClass`
 * instances carrying extra fields (`agentStatus`, `ownerUserId`) —
 * structurally inhabit this union (`_tag` + `agentId` / `appId` match;
 * extra fields are fine for a read-only consumer), so the server provides
 * the live narrowed arm directly. The `appId` of the app arm is sourced
 * from the live `AppConnection.auth` minted at auth time, NOT hardcoded.
 */
export type Principal =
  | { readonly _tag: "AgentContext"; readonly agentId: AgentId }
  | { readonly _tag: "AppContext"; readonly appId: AppId };

/**
 * Protocol-owned `Context.Tag` carrying the request's authenticated
 * {@link Principal}. The capability middleware's `derivePayload` `yield*`s
 * it WITHOUT importing the server; the server SATISFIES it by
 * `provideService(CurrentPrincipal, principalCtx)` at the dispatch site.
 * Provided ONLY on authenticated/capability-bearing methods — capabilities
 * never run on the unauth Connect frame — so the unauth arm is never a
 * concern here.
 */
export class CurrentPrincipal extends Context.Tag(
  "@moltzap/protocol/CurrentPrincipal",
)<CurrentPrincipal, Principal>() {}

/**
 * Impossible-state defect: a capability `derivePayload` read the principal
 * and found a NON-agent arm. Every live descriptor cap is agent-originated
 * (its binding's `callablePrincipal` is `"agent"`), so the binding
 * guarantees an agent caller; an app arm here is a wiring defect, not a
 * caller-actionable error. {@link Effect.die} (not a caller-visible error)
 * because the principal-kind gate already rejected non-agent callers.
 */
export const callerAgentId: Effect.Effect<AgentId, never, CurrentPrincipal> =
  Effect.gen(function* () {
    const p = yield* CurrentPrincipal;
    // Exhaustive narrow on the tagged union — NOT an `as { agentId }`
    // assertion. The agent arm's `agentId` is reached by discriminant.
    return p._tag === "AgentContext"
      ? p.agentId
      : yield* Effect.die(
          new Error(
            `capability derivePayload reached a non-agent principal: ${p._tag}`,
          ),
        );
  }).pipe(Effect.withSpan("callerAgentId"));
