/**
 * @file The per-capability `@effect/rpc` middleware impl Layers — one
 * server-supplied per-socket `Layer` over each protocol-owned cap middleware
 * (`@moltzap/protocol` `cap-middlewares.ts`).
 *
 * Each capability is its own `RpcMiddleware.Tag`; the engine stacks the
 * principal gate plus the method's declared cap middlewares
 * (`server-engine-group.ts → buildEngineMember`). The descriptor (the cap
 * `Context.Tag` + the middleware Tag + its `failure`) is protocol-owned; the
 * impl that resolves a connection to its narrowed arm (the gate) or runs a cap's
 * derive/obtain (a cap mw) is a server concern, supplied here.
 *
 * The principal gate is ONE impl over `PrincipalGateMw`, stacked on every
 * authenticated method: it reads the running `rpc._tag`, looks up that method's
 * policy (`callablePrincipal` + `requiresActive`) in {@link policyByTag}, narrows
 * the live arm, and fails `Unauthorized` / `Forbidden`. It provides nothing —
 * the handler reads the narrowed arm off `ConnectionTag` (`agentArm`/`appArm`).
 *
 * Each cap mw impl peeks the live arm for the caller's agent id, derives its
 * input from the decoded `payload`, and runs the cap's `obtain` — providing the
 * cap's `Context.Tag` value. The engine composes the stack in order, so a
 * downstream cap (`ActiveTaskPermission`) reads an upstream cap's provided value
 * (`ConversationSendAccess`) from context. A cap-obtain failure encodes against
 * that cap mw's own `failure` schema.
 */
import { Effect, Layer } from "effect";
import {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
  ActiveTaskPermissionMw,
  OpenConversationPermissionMw,
  ReplyTargetPermissionMw,
  TaskReadAccessMw,
  ContactPolicyAllowsReachMw,
  ConversationInTask,
  ConversationSendAccess,
  ActiveTaskPermission,
  OpenConversationPermission,
  ReplyTargetPermission,
  TaskReadAccess,
  ContactPolicyAllowsReach,
  CurrentPrincipal,
  type CallablePrincipal,
  type ConversationId,
  type TaskId,
  type MessageId,
} from "@moltzap/protocol";
import { serverRpcMethods } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import {
  ConnectionManagerTag,
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../app/layers.js";
import {
  obtainTaskReadAccess,
  obtainConversationInTask,
  obtainContactPolicyAllowsReach,
} from "../app/capability-middlewares.js";
import {
  obtainConversationSendAccess,
  obtainActiveTaskPermission,
  obtainOpenConversationPermission,
  obtainReplyTargetPermission,
} from "../task/services/send-permissions.js";
import { narrowByPolicy, peekLiveArm } from "./principal-gate.js";

/** The principal policy a method's gate enforces. */
interface PrincipalPolicy {
  readonly callablePrincipal: CallablePrincipal;
  readonly requiresActive: boolean;
}

/**
 * Method wire tag → its principal policy. Built once from the descriptor catalog
 * so the single `PrincipalGateMw` impl narrows per the running method's
 * `callablePrincipal` + `requiresActive` (read off `rpc._tag`), with no parallel
 * literal table.
 */
const policyByTag: ReadonlyMap<string, PrincipalPolicy> = new Map(
  serverRpcMethods.map((d) => [
    d.name as string,
    {
      callablePrincipal: d.callablePrincipal,
      requiresActive: d.requiresActive,
    },
  ]),
);

/** Read the caller's agent id off the live arm (cap mws derive from it). */
const callerAgentIdFor = (
  manager: ConnectionManagerService,
  connId: ConnectionId,
): Effect.Effect<AgentId> =>
  peekLiveArm(manager, connId).pipe(
    Effect.flatMap((connection) =>
      connection._tag === "AgentConnection"
        ? Effect.succeed(connection.auth.agentId)
        : Effect.dieMessage(
            `cap middleware: agent-gated cap reached on ${connection._tag} arm`,
          ),
    ),
  );

type ConnectionManagerService = Parameters<typeof peekLiveArm>[0];

// ── Principal gate ───────────────────────────────────────────────────────────

/**
 * The `PrincipalGateMw` impl Layer for one socket: reads the running method's
 * policy, narrows the live arm, fails `Unauthorized`/`Forbidden`. Returns void —
 * a pure gate. Stacked on every authenticated method by `buildEngineMember`.
 */
export const makePrincipalGateLayer = (connId: ConnectionId) =>
  Layer.effect(
    PrincipalGateMw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return ({ rpc }) =>
        Effect.gen(function* () {
          const policy = policyByTag.get(rpc._tag);
          if (policy === undefined) {
            return yield* Effect.dieMessage(
              `principal gate: no policy for method ${rpc._tag}`,
            );
          }
          const connection = yield* peekLiveArm(manager, connId);
          yield* narrowByPolicy(
            policy.callablePrincipal,
            policy.requiresActive,
            connection,
          );
        }).pipe(Effect.withSpan("AuthMiddleware.principalGate"));
    }),
  );

// ── Cap middlewares ───────────────────────────────────────────────────────────

/** The cap obtains' service env. */
type MwEnv = TaskServiceTag | ConversationServiceTag | MessageServiceTag;

type SendParams = {
  readonly taskId?: TaskId;
  readonly conversationId: ConversationId;
  readonly replyToId?: MessageId;
};
type TaskAndConvParams = {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
};
type TaskAndAgentParams = { readonly taskId: TaskId };
type CreateConvParams = { readonly targetAgentIds: readonly AgentId[] };

/** `ConversationInTask` cap mw impl Layer (no principal read; pure params). */
export const makeConversationInTaskMwLayer = (_connId: ConnectionId) =>
  Layer.effect(
    ConversationInTaskMw,
    Effect.succeed(({ payload }) => {
      const p = payload as TaskAndConvParams;
      return obtainConversationInTask({
        taskId: p.taskId,
        conversationId: p.conversationId,
      });
    }),
  );

/**
 * `ConversationSendAccess` cap mw impl Layer: peek the caller's agent id, prove
 * participation, and do the one joined read the downstream send caps read off.
 */
export const makeConversationSendAccessMwLayer = (connId: ConnectionId) =>
  Layer.effect(
    ConversationSendAccessMw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return ({ payload }) =>
        Effect.gen(function* () {
          const p = payload as SendParams;
          const senderAgentId = yield* callerAgentIdFor(manager, connId);
          return yield* obtainConversationSendAccess({
            conversationId: p.conversationId,
            senderAgentId,
            taskId: p.taskId,
          });
        });
    }),
  );

/** `ActiveTaskPermission` cap mw impl Layer: reads the shared send row. */
export const makeActiveTaskPermissionMwLayer = (_connId: ConnectionId) =>
  Layer.effect(
    ActiveTaskPermissionMw,
    Effect.succeed(() => obtainActiveTaskPermission()),
  );

/** `OpenConversationPermission` cap mw impl Layer: reads the shared send row. */
export const makeOpenConversationPermissionMwLayer = (_connId: ConnectionId) =>
  Layer.effect(
    OpenConversationPermissionMw,
    Effect.succeed(() => obtainOpenConversationPermission()),
  );

/** `ReplyTargetPermission` cap mw impl Layer: conditional reply existence read. */
export const makeReplyTargetPermissionMwLayer = (_connId: ConnectionId) =>
  Layer.effect(
    ReplyTargetPermissionMw,
    Effect.succeed(({ payload }) => {
      const p = payload as SendParams;
      return obtainReplyTargetPermission({
        conversationId: p.conversationId,
        replyToId: p.replyToId,
      });
    }),
  );

/** `TaskReadAccess` cap mw impl Layer: peek caller, prove read access. */
export const makeTaskReadAccessMwLayer = (connId: ConnectionId) =>
  Layer.effect(
    TaskReadAccessMw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return ({ payload }) =>
        Effect.gen(function* () {
          const p = payload as TaskAndAgentParams;
          const callerAgentId = yield* callerAgentIdFor(manager, connId);
          return yield* obtainTaskReadAccess({
            taskId: p.taskId,
            callerAgentId,
          });
        });
    }),
  );

/** `ContactPolicyAllowsReach` cap mw impl Layer: peek caller, check policy. */
export const makeContactPolicyAllowsReachMwLayer = (connId: ConnectionId) =>
  Layer.effect(
    ContactPolicyAllowsReachMw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return ({ payload }) =>
        Effect.gen(function* () {
          const p = payload as CreateConvParams;
          const creatorAgentId = yield* callerAgentIdFor(manager, connId);
          return yield* obtainContactPolicyAllowsReach({
            creatorAgentId,
            targetAgentIds: p.targetAgentIds,
          });
        });
    }),
  );

/**
 * Every per-socket cap-middleware impl Layer, merged. The engine stacks each cap
 * mw on the methods that declare it; this provides ONE impl per cap mw Tag for
 * the socket (the impl ignores methods that do not stack it).
 */
export const makeCapMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makePrincipalGateLayer(connId),
    makeConversationInTaskMwLayer(connId),
    makeConversationSendAccessMwLayer(connId),
    makeActiveTaskPermissionMwLayer(connId),
    makeOpenConversationPermissionMwLayer(connId),
    makeReplyTargetPermissionMwLayer(connId),
    makeTaskReadAccessMwLayer(connId),
    makeContactPolicyAllowsReachMwLayer(connId),
  );

// Re-export so `CurrentPrincipal`/`MwEnv` consumers keep a stable path.
export { CurrentPrincipal };
export type { MwEnv };
