/**
 * @file Runtime helpers shared by the `@effect/rpc` handler bodies
 * (`*.handlers.ts` exports, assembled in `server-handlers.ts`).
 *
 * Requirement middleware has already gated the frame. The body types its `ctx`
 * against the full {@link AgentContext} / {@link AppContext} so it can read
 * `ownerUserId` / `agentStatus`. The full arm is read off the request-scoped
 * {@link ConnectionTag}; principal requirements have already gated the arm, so
 * a non-matching `_tag` here is an impossible-state defect, not a
 * caller-actionable rejection.
 *
 * `agentArm`/`appArm` are the two narrowing reads: each reads `ConnectionTag`,
 * asserts the gated arm, and yields the full context the body types against.
 * A handler fails with its declared tagged-error INSTANCES; the engine encodes
 * them against the method's per-method `errorSchema` union. There is no
 * domain-error→envelope projection — defects bypass typed errors and surface as
 * the engine's `ResponseDefect`.
 */
import { Effect } from "effect";
import {
  ConnectionManagerTag,
  ConnectionTag,
  type AgentContext,
  type AppContext,
} from "#socket";
import { peekLiveArm } from "./principal-gate.js";

/**
 * Read the LIVE connection arm for this request. `ConnectionTag` is a per-socket
 * BUILD-time snapshot (it predates `agent/network/connect` / `app/network/connect`, so its `_tag` is still
 * `UnauthenticatedConnection`); the connection arm transitions to
 * `AgentConnection` / `AppConnection` AFTER connect runs. The handler must read
 * the live arm; `ConnectionTag` only carries the stable `connId` used to
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
