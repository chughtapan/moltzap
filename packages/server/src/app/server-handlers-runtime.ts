/**
 * @file Runtime helpers shared by the `@effect/rpc` handler bodies
 * (`*.handlers.ts` exports, assembled in `server-handlers.ts`).
 *
 * A handler reads its method's `*Auth` proof for the narrowed principal id and
 * the cap proofs, then runs the handler body.
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
 * handler via `Effect.provideService` around the body effect, reading each
 * value off the method's proof keyed by the cap tag's `key`.
 *
 * A handler fails with its declared tagged-error INSTANCES; the engine encodes
 * them against the method's per-method `errorSchema` union. There is no
 * domain-error→envelope projection — defects bypass typed errors and surface as
 * the engine's `ResponseDefect`.
 */
import { Effect } from "effect";
import { ConnectionManagerTag, ConnectionTag } from "./layers.js";
import { peekLiveArm } from "../transport/principal-gate.js";
import type { AgentContext, AppContext } from "../transport/context.js";

/**
 * Read the LIVE connection arm for this request. `ConnectionTag` is a per-socket
 * BUILD-time snapshot (it predates `network/connect`, so its `_tag` is still
 * `UnauthenticatedConnection`); the connection arm transitions to
 * `AgentConnection` / `AppConnection` AFTER connect runs. The handler must read
 * the CURRENT arm — `ConnectionTag` only carries the stable `connId` used to
 * re-peek the live arm off the manager.
 */
const liveArm = Effect.gen(function* () {
  const snapshot = yield* ConnectionTag;
  const manager = yield* ConnectionManagerTag;
  return yield* peekLiveArm(manager, snapshot.connId);
});

/**
 * Read the request-scoped agent context for a handler whose principal
 * gate narrowed the arm to `"agent"`. A non-agent arm is an impossible-state
 * defect: the gate runs before the handler, so reaching here off a non-agent arm
 * means the engine ran a handler whose middleware should have rejected the frame.
 */
export const agentArm: Effect.Effect<
  AgentContext,
  never,
  ConnectionTag | ConnectionManagerTag
> = Effect.gen(function* () {
  const connection = yield* liveArm;
  if (connection._tag !== "AgentConnection") {
    return yield* Effect.dieMessage(
      `handler: agent-gated method reached on ${connection._tag} arm`,
    );
  }
  return connection.auth;
}).pipe(Effect.withSpan("serverHandlers.agentArm"));

/**
 * Read the request-scoped app context for a handler whose principal gate
 * narrowed the arm to `"app"`. A non-app arm is an impossible-state defect for
 * the same reason as {@link agentArm}.
 */
export const appArm: Effect.Effect<
  AppContext,
  never,
  ConnectionTag | ConnectionManagerTag
> = Effect.gen(function* () {
  const connection = yield* liveArm;
  if (connection._tag !== "AppConnection") {
    return yield* Effect.dieMessage(
      `handler: app-gated method reached on ${connection._tag} arm`,
    );
  }
  return connection.auth;
}).pipe(Effect.withSpan("serverHandlers.appArm"));
