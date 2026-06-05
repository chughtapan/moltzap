/**
 * @file The per-requirement `@effect/rpc` middleware impl Layers — one
 * server-supplied per-socket `Layer` over each protocol-owned middleware
 * (`@moltzap/protocol` `requirements.ts`).
 *
 * Each requirement is its own `RpcMiddleware.Tag`; the engine stacks the
 * method's declared requirements (`server-lifecycle.ts -> buildEngineMember`).
 * The descriptor tag + its `failure` schema are protocol-owned; the impl that
 * resolves a connection to its narrowed arm or runs a cap obtain is a server
 * concern, supplied here.
 *
 * Principal requirements are gate-only middleware: they narrow the live arm and
 * fail `Unauthorized` / `Forbidden`. They provide nothing; handlers read the
 * narrowed arm off `ConnectionTag` (`agentArm`/`appArm`).
 *
 * Each cap requirement impl peeks the live arm when it needs the caller's agent
 * id, derives input from the decoded `payload`, and runs the cap's `obtain`.
 * A cap-obtain failure encodes against that requirement's own `failure` schema.
 */
import { Context, Effect, Layer } from "effect";
import type { RpcMiddleware } from "@effect/rpc";
import {
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
  AgentClaimed,
} from "@moltzap/protocol/transport";
import {
  ConversationInTask,
  ConversationSendAccess,
  TaskReadAccess,
  ContactPolicyAllowsReach,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol/task";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/runtime";
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

// ── Principal requirements ───────────────────────────────────────────────────

const principalLayer = <Mw extends RpcMiddleware.TagClassAny>(
  mw: Mw,
  connId: ConnectionId,
  check: (manager: ConnectionManagerService) => Effect.Effect<void, unknown>,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, ConnectionManagerTag> =>
  Layer.effect(
    mw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return () =>
        check(manager).pipe(Effect.withSpan(`requirement.${mw.key}`));
    }),
  );

const makeAgentPrincipalLayer = (connId: ConnectionId) =>
  principalLayer(AgentPrincipal, connId, (manager) =>
    peekLiveArm(manager, connId).pipe(
      Effect.flatMap((connection) =>
        narrowByPolicy(AgentPrincipal, false, connection),
      ),
      Effect.asVoid,
    ),
  );

const makeAppPrincipalLayer = (connId: ConnectionId) =>
  principalLayer(AppPrincipal, connId, (manager) =>
    peekLiveArm(manager, connId).pipe(
      Effect.flatMap((connection) =>
        narrowByPolicy(AppPrincipal, false, connection),
      ),
      Effect.asVoid,
    ),
  );

const makeAuthenticatedPrincipalLayer = (connId: ConnectionId) =>
  principalLayer(AuthenticatedPrincipal, connId, (manager) =>
    peekLiveArm(manager, connId).pipe(
      Effect.flatMap((connection) =>
        narrowByPolicy(AuthenticatedPrincipal, false, connection),
      ),
      Effect.asVoid,
    ),
  );

const makeAgentClaimedLayer = (connId: ConnectionId) =>
  principalLayer(AgentClaimed, connId, (manager) =>
    peekLiveArm(manager, connId).pipe(
      Effect.flatMap((connection) =>
        narrowByPolicy(AgentPrincipal, true, connection),
      ),
      Effect.asVoid,
    ),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTaskAndConvParams = (payload: unknown): payload is TaskAndConvParams =>
  isRecord(payload) &&
  typeof payload["taskId"] === "string" &&
  typeof payload["conversationId"] === "string";

const isSendParams = (payload: unknown): payload is SendParams =>
  isRecord(payload) &&
  (payload["taskId"] === undefined || typeof payload["taskId"] === "string") &&
  typeof payload["conversationId"] === "string";

const isTaskAndAgentParams = (
  payload: unknown,
): payload is TaskAndAgentParams =>
  isRecord(payload) && typeof payload["taskId"] === "string";

const isTaskRequestParams = (payload: unknown): payload is TaskRequestParams =>
  isRecord(payload) &&
  Array.isArray(payload["invitedAgentIds"]) &&
  payload["invitedAgentIds"].every((id) => typeof id === "string");

function requirePayload<A>(
  payload: unknown,
  guard: (payload: unknown) => payload is A,
  requirement: string,
): Effect.Effect<A> {
  if (guard(payload)) return Effect.succeed(payload);
  return Effect.dieMessage(
    `cap middleware ${requirement}: incompatible RPC payload`,
  );
}

/**
 * The cap obtains' service env as a `Context` snapshot, read once at Layer build
 * (per socket). Each cap mw impl `Effect.provide`s it so the impl's Effect has
 * no service `R` — the `RpcMiddleware` contract is `Effect&lt;void, E>` with
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
  derive: (payload: unknown) => Effect.Effect<In>,
  obtain: (input: In) => Effect.Effect<Value, Err, MwEnv>,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, CapMwLayerR> =>
  Layer.effect(
    mw,
    Effect.map(
      mwEnv,
      (env) =>
        ({ payload }: MwOptions) =>
          derive(payload).pipe(
            Effect.flatMap(obtain),
            Effect.asVoid,
            Effect.provide(env),
          ),
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
  derive: (payload: unknown, callerAgentId: AgentId) => Effect.Effect<In>,
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
            const input = yield* derive(payload, callerAgentId);
            return yield* obtain(input);
          }).pipe(Effect.asVoid, Effect.provide(env)),
    ),
  );

const makeConversationInTaskLayer = () =>
  capMwLayer(
    ConversationInTask,
    (payload) =>
      requirePayload(payload, isTaskAndConvParams, ConversationInTask.key).pipe(
        Effect.map((p) => ({
          taskId: p.taskId,
          conversationId: p.conversationId,
        })),
      ),
    obtainConversationInTask,
  );

const makeConversationSendAccessLayer = (connId: ConnectionId) =>
  capMwLayerWithCaller(
    ConversationSendAccess,
    connId,
    (payload, senderAgentId) =>
      requirePayload(payload, isSendParams, ConversationSendAccess.key).pipe(
        Effect.map((p) => ({
          conversationId: p.conversationId,
          senderAgentId,
          taskId: p.taskId,
        })),
      ),
    obtainConversationSendAccess,
  );

const makeTaskReadAccessLayer = (connId: ConnectionId) =>
  capMwLayerWithCaller(
    TaskReadAccess,
    connId,
    (payload, callerAgentId) =>
      requirePayload(payload, isTaskAndAgentParams, TaskReadAccess.key).pipe(
        Effect.map((p) => ({
          taskId: p.taskId,
          callerAgentId,
        })),
      ),
    obtainTaskReadAccess,
  );

const makeContactPolicyAllowsReachLayer = (connId: ConnectionId) =>
  capMwLayerWithCaller(
    ContactPolicyAllowsReach,
    connId,
    (payload, creatorAgentId) =>
      requirePayload(
        payload,
        isTaskRequestParams,
        ContactPolicyAllowsReach.key,
      ).pipe(
        Effect.map((p) => ({
          creatorAgentId,
          targetAgentIds: [...p.invitedAgentIds],
        })),
      ),
    obtainContactPolicyAllowsReach,
  );

/**
 * Every per-socket requirement impl Layer, merged. The engine stacks each
 * requirement on the methods that declare it. `ConversationInTask` reads no
 * caller (pure params — it gates app-principal methods too); the rest peek the
 * caller's agent id.
 */
export const makeCapMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makeAgentPrincipalLayer(connId),
    makeAppPrincipalLayer(connId),
    makeAuthenticatedPrincipalLayer(connId),
    makeAgentClaimedLayer(connId),
    makeConversationInTaskLayer(),
    makeConversationSendAccessLayer(connId),
    makeTaskReadAccessLayer(connId),
    makeContactPolicyAllowsReachLayer(connId),
  );
