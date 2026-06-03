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
 * policy (the `requires` head + whether it requires a claimed agent) in
 * {@link policyByTag}, narrows the live arm, and fails `Unauthorized` /
 * `Forbidden`. It provides nothing — the handler reads the narrowed arm off
 * `ConnectionTag` (`agentArm`/`appArm`).
 *
 * Each cap mw impl peeks the live arm for the caller's agent id, derives its
 * input from the decoded `payload`, and runs the cap's `obtain` — providing the
 * cap's `Context.Tag` value to the handler. `@effect/rpc` runs each middleware
 * impl in isolation (no `R`), so a cap mw cannot read another mw's provided
 * value; a precondition that refines a fetched row (the send guards on
 * `ConversationSendAccess`) is a handler-body guard, not a middleware. A
 * cap-obtain failure encodes against that cap mw's own `failure` schema.
 */
import { Context, Effect, Layer } from "effect";
import type { RpcMiddleware } from "@effect/rpc";
import {
  PrincipalGateMw,
  ConversationInTaskMw,
  ConversationSendAccessMw,
  TaskReadAccessMw,
  ContactPolicyAllowsReachMw,
  serverRpcMethods,
  principalRequirementOf,
  requiresClaimed,
  type PrincipalRequirement,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol";
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
import { obtainConversationSendAccess } from "../task/services/send-permissions.js";
import { narrowByPolicy, peekLiveArm } from "./principal-gate.js";

/** The principal policy a method's gate enforces — read off its `requires`. */
interface PrincipalPolicy {
  /** The `requires` head; `undefined` only for the empty-`requires` method. */
  readonly principal: PrincipalRequirement | undefined;
  readonly requiresClaimed: boolean;
}

/**
 * Method wire tag → its principal policy. Built once from the descriptor catalog
 * so the single `PrincipalGateMw` impl narrows per the running method's `requires`
 * head + the `AgentClaimed` refinement (read off `rpc._tag`), with no parallel
 * literal table.
 */
const policyByTag: ReadonlyMap<string, PrincipalPolicy> = new Map(
  serverRpcMethods.map((d) => [
    d.name as string,
    {
      principal: principalRequirementOf(d.requires),
      requiresClaimed: requiresClaimed(d.requires),
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
const makePrincipalGateLayer = (connId: ConnectionId) =>
  Layer.effect(
    PrincipalGateMw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return ({ rpc }: MwOptions) =>
        Effect.gen(function* () {
          const policy = policyByTag.get(rpc._tag);
          if (policy === undefined) {
            return yield* Effect.dieMessage(
              `principal gate: no policy for method ${rpc._tag}`,
            );
          }
          const connection = yield* peekLiveArm(manager, connId);
          yield* narrowByPolicy(
            policy.principal,
            policy.requiresClaimed,
            connection,
          );
        }).pipe(Effect.withSpan("AuthMiddleware.principalGate"));
    }),
  );

// ── Cap middlewares ───────────────────────────────────────────────────────────

/** The cap obtains' service env. */
type MwEnv = TaskServiceTag | ConversationServiceTag | MessageServiceTag;

/** The options an `@effect/rpc` `RpcMiddleware` impl receives per request. */
interface MwOptions {
  readonly clientId: number;
  readonly rpc: { readonly _tag: string };
  readonly payload: unknown;
}

type SendParams = {
  readonly taskId?: TaskId;
  readonly conversationId: ConversationId;
};
type TaskAndConvParams = {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
};
type TaskAndAgentParams = { readonly taskId: TaskId };
type TaskRequestParams = { readonly invitedAgentIds: readonly AgentId[] };

/**
 * The cap obtains' service env as a `Context` snapshot, read once at Layer build
 * (per socket). Each cap mw impl `Effect.provide`s it so the impl's Effect has
 * no service `R` — the `RpcMiddleware` contract is `Effect&lt;Provides, E>` with
 * no context channel.
 */
const mwEnv = Effect.gen(function* () {
  const taskService = yield* TaskServiceTag;
  const conversationService = yield* ConversationServiceTag;
  const messageService = yield* MessageServiceTag;
  const manager = yield* ConnectionManagerTag;
  return Context.empty().pipe(
    Context.add(TaskServiceTag, taskService),
    Context.add(ConversationServiceTag, conversationService),
    Context.add(MessageServiceTag, messageService),
    Context.add(ConnectionManagerTag, manager),
  );
});

/**
 * The Layer requirement every cap mw impl shares: the obtain services plus the
 * connection manager (for the caller-peeking variant).
 */
type CapMwLayerR =
  | TaskServiceTag
  | ConversationServiceTag
  | MessageServiceTag
  | ConnectionManagerTag;

/**
 * Build a cap mw impl Layer whose `derive` reads ONLY the decoded `payload` (no
 * caller). Used for caps that gate on pure params — e.g. `ConversationInTask`,
 * which the app-principal `task/conversation/*` methods declare, so its impl
 * MUST NOT peek the caller's AGENT id (the live arm is an `AppConnection`).
 */
const capMwLayer = <Mw extends RpcMiddleware.TagClassAny, Value, Err, In>(
  mw: Mw,
  derive: (payload: unknown) => In,
  obtain: (input: In) => Effect.Effect<Value, Err, MwEnv>,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, CapMwLayerR> =>
  Layer.effect(
    mw,
    Effect.map(
      mwEnv,
      (env) =>
        ({ payload }: MwOptions) =>
          obtain(derive(payload)).pipe(Effect.provide(env)),
    ),
  );

/**
 * Build a cap mw impl Layer whose `derive` ALSO reads the caller's agent id,
 * peeked off the live arm. Used by the agent-principal caps
 * (`ConversationSendAccess`, `TaskReadAccess`, `ContactPolicyAllowsReach`); the
 * peek dies on a non-agent arm, which is sound only because these caps gate
 * agent-callable methods.
 */
const capMwLayerWithCaller = <
  Mw extends RpcMiddleware.TagClassAny,
  Value,
  Err,
  In,
>(
  mw: Mw,
  connId: ConnectionId,
  derive: (payload: unknown, callerAgentId: AgentId) => In,
  obtain: (input: In) => Effect.Effect<Value, Err, MwEnv>,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, CapMwLayerR> =>
  Layer.effect(
    mw,
    Effect.map(
      mwEnv,
      (env) =>
        ({ payload }: MwOptions) =>
          Effect.gen(function* () {
            const callerAgentId = yield* callerAgentIdFor(
              Context.get(env, ConnectionManagerTag),
              connId,
            );
            return yield* obtain(derive(payload, callerAgentId));
          }).pipe(Effect.provide(env)),
    ),
  );

/**
 * Every per-socket cap-middleware impl Layer, merged. The engine stacks each cap
 * mw on the methods that declare it; this provides ONE impl per cap mw Tag for
 * the socket (the impl ignores methods that do not stack it). `ConversationInTask`
 * reads no caller (pure params — it gates app-principal methods too); the rest
 * peek the caller's agent id.
 */
export const makeCapMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makePrincipalGateLayer(connId),
    capMwLayer(
      ConversationInTaskMw,
      (payload) => {
        const p = payload as TaskAndConvParams;
        return { taskId: p.taskId, conversationId: p.conversationId };
      },
      obtainConversationInTask,
    ),
    capMwLayerWithCaller(
      ConversationSendAccessMw,
      connId,
      (payload, senderAgentId) => {
        const p = payload as SendParams;
        return {
          conversationId: p.conversationId,
          senderAgentId,
          taskId: p.taskId,
        };
      },
      obtainConversationSendAccess,
    ),
    capMwLayerWithCaller(
      TaskReadAccessMw,
      connId,
      (payload, callerAgentId) => ({
        taskId: (payload as TaskAndAgentParams).taskId,
        callerAgentId,
      }),
      obtainTaskReadAccess,
    ),
    capMwLayerWithCaller(
      ContactPolicyAllowsReachMw,
      connId,
      (payload, creatorAgentId) => ({
        creatorAgentId,
        targetAgentIds: [...(payload as TaskRequestParams).invitedAgentIds],
      }),
      obtainContactPolicyAllowsReach,
    ),
  );
