/**
 * @file Runtime helpers shared by the native `@effect/rpc` handler bodies
 * (`*.handlers.ts` `native*` exports, assembled in `native-handlers.ts`).
 *
 * A native handler reads its method's `*Auth` proof for the narrowed principal
 * id and the cap proofs, then runs the handler body
 * The body types its `ctx` against the FULL {@link AgentContext} /
 * {@link AppContext} (it reads `ownerUserId`/`agentStatus`, which the proof's
 * `PrincipalForKind` projection does not expose). The full arm is read off the
 * request-scoped {@link ConnectionTag}; the per-method `*AuthMw` has already
 * gated the arm to the method's principal kind, so a non-matching `_tag` here
 * is an impossible-state defect, not a caller-actionable rejection.
 *
 * `agentArm`/`appArm` are the two narrowing reads: each reads `ConnectionTag`,
 * asserts the gated arm, and yields the full context the body types against.
 * Cap proofs (when a method declares caps) are provided as services by the
 * native handler via `Effect.provideService` around the body effect, reading
 * each value off the method's proof keyed by the cap tag's `key`.
 *
 * `toWireError` re-exports the live dispatcher's domain-error→wire projection so
 * a native handler maps its `Effect.gen` body's domain error channel to the
 * `WireError` envelope each engine member's `error` schema carries. Defects
 * bypass it and surface as the engine's `ResponseDefect`, matching the live
 * path's untagged `-32603` reply.
 */
import { Effect } from "effect";
import { ConnectionTag } from "./layers.js";
import type { AgentContext, AppContext } from "../transport/context.js";
import { toWireError } from "../transport/principal-gate.js";

export { toWireError };

/**
 * Read the request-scoped agent context for a native handler whose `*AuthMw`
 * gated the arm to `"agent"`. A non-agent arm is an impossible-state defect:
 * the gate runs before the handler, so reaching here off a non-agent arm means
 * the engine ran a handler whose middleware should have rejected the frame.
 */
export const agentArm: Effect.Effect<AgentContext, never, ConnectionTag> =
  Effect.gen(function* () {
    const connection = yield* ConnectionTag;
    if (connection._tag !== "AgentConnection") {
      return yield* Effect.dieMessage(
        `native handler: agent-gated method reached on ${connection._tag} arm`,
      );
    }
    return connection.auth;
  }).pipe(Effect.withSpan("native.agentArm"));

/**
 * Read the request-scoped app context for a native handler whose `*AuthMw`
 * gated the arm to `"app"`. A non-app arm is an impossible-state defect for the
 * same reason as {@link agentArm}.
 */
export const appArm: Effect.Effect<AppContext, never, ConnectionTag> =
  Effect.gen(function* () {
    const connection = yield* ConnectionTag;
    if (connection._tag !== "AppConnection") {
      return yield* Effect.dieMessage(
        `native handler: app-gated method reached on ${connection._tag} arm`,
      );
    }
    return connection.auth;
  }).pipe(Effect.withSpan("native.appArm"));
