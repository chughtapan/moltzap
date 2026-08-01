/**
 * @file The per-requirement `@effect/rpc` middleware impl Layers — one
 * server-supplied per-socket `Layer` over each protocol-owned middleware tag.
 *
 * Each requirement is its own `RpcMiddleware.Tag`; the engine stacks the
 * method's declared requirements (`socket/server.ts -> buildEngineMember`).
 * The descriptor tag + its `failure` schema are protocol-owned; the impl that
 * resolves a connection to its narrowed arm or runs a requirement obtain is a server
 * concern, supplied here.
 *
 * Principal requirements are gate-only middleware: they narrow the live arm and
 * fail `Unauthorized` / `Forbidden`. They provide nothing; handlers read the
 * narrowed arm off `ConnectionTag` (`agentArm`/`appArm`).
 *
 * Each domain requirement impl peeks the live arm when it needs the caller's
 * agent id, derives input from the decoded `payload`, and runs the requirement's
 * `obtain`. An obtain failure encodes against that requirement's own `failure`
 * schema.
 */
// safer-arch-ignore no-fat-orchestrator: This module is the assembly point for the complete protocol requirement Layer catalog used by each socket runtime.

import { Context, Effect, Layer } from "effect";
import type { RpcMiddleware } from "@effect/rpc";
import {
  ActiveAgent,
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
  ContactPolicyAllowsReach,
  type PrincipalRequirement,
} from "@moltzap/protocol/identity";
import {
  ConversationInTask,
  ConversationSendAccess,
} from "@moltzap/protocol/conversation";
import { type TaskId, TaskReadAccess } from "@moltzap/protocol/task";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import { ConnectionManagerTag } from "#socket";
import { ConversationServiceTag } from "#conversation";
import { MessageServiceTag } from "#message";
import { TaskServiceTag } from "#task";
import { obtainTaskReadAccess } from "#task/requirements";
import { obtainConversationInTask } from "#conversation/requirements";
import { obtainContactPolicyAllowsReach } from "#identity/contacts/requirements";
import { obtainConversationSendAccess } from "#conversation/requirements";
import { narrowByPolicy, peekLiveArm } from "./principal-gate.js";

/** Read the caller's agent id off the live arm when a requirement derives from it. */
function callerAgentIdFor(
  manager: ConnectionManagerService,
  connId: ConnectionId,
): Effect.Effect<AgentId> {
  return peekLiveArm(manager, connId).pipe(
    Effect.flatMap((connection) =>
      connection._tag === "AgentConnection"
        ? Effect.succeed(connection.auth.agentId)
        : Effect.dieMessage(
            `requirement middleware: agent-gated requirement reached on ${connection._tag} arm`,
          ),
    ),
  );
}

type ConnectionManagerService = Parameters<typeof peekLiveArm>[0];

// ── Principal requirements ───────────────────────────────────────────────────

/**
 * Build a principal requirement impl Layer: peek the live arm and narrow it to
 * `narrowAs` (with `requireActiveAgent` for the `ActiveAgent` arm). The layer
 * provides nothing — it gates only, failing `Forbidden` on the wrong arm.
 */
function principalLayer<Mw extends RpcMiddleware.TagClassAny>(
  mw: Mw,
  connId: ConnectionId,
  narrowAs: PrincipalRequirement,
  requireActiveAgent: boolean,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, ConnectionManagerTag> {
  return Layer.effect(
    mw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      return () =>
        peekLiveArm(manager, connId).pipe(
          Effect.flatMap((connection) =>
            narrowByPolicy(narrowAs, requireActiveAgent, connection),
          ),
          Effect.asVoid,
          Effect.withSpan(`requirement.${mw.key}`),
        );
    }),
  );
}

function makeAgentPrincipalLayer(connId: ConnectionId) {
  return principalLayer(AgentPrincipal, connId, AgentPrincipal, false);
}

function makeAppPrincipalLayer(connId: ConnectionId) {
  return principalLayer(AppPrincipal, connId, AppPrincipal, false);
}

function makeAuthenticatedPrincipalLayer(connId: ConnectionId) {
  return principalLayer(
    AuthenticatedPrincipal,
    connId,
    AuthenticatedPrincipal,
    false,
  );
}

function makeActiveAgentLayer(connId: ConnectionId) {
  return principalLayer(ActiveAgent, connId, AgentPrincipal, true);
}

// ── Domain requirements ──────────────────────────────────────────────────────

/** The requirement obtains' service env. */
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
type TaskRequestParams = {
  readonly invitedAgentIds: readonly AgentId[];
  readonly initialConversation?: {
    readonly participants?: readonly AgentId[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskAndConvParams(payload: unknown): payload is TaskAndConvParams {
  return (
    isRecord(payload) &&
    typeof payload["taskId"] === "string" &&
    typeof payload["conversationId"] === "string"
  );
}

function isSendParams(payload: unknown): payload is SendParams {
  return (
    isRecord(payload) &&
    (payload["taskId"] === undefined ||
      typeof payload["taskId"] === "string") &&
    typeof payload["conversationId"] === "string"
  );
}

function isTaskAndAgentParams(payload: unknown): payload is TaskAndAgentParams {
  return isRecord(payload) && typeof payload["taskId"] === "string";
}

function isAgentIdArray(value: unknown): value is readonly AgentId[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

function isTaskRequestParams(payload: unknown): payload is TaskRequestParams {
  if (!isRecord(payload) || !isAgentIdArray(payload["invitedAgentIds"])) {
    return false;
  }
  const initial = payload["initialConversation"];
  if (initial === undefined) return true;
  return (
    isRecord(initial) &&
    (initial["participants"] === undefined ||
      isAgentIdArray(initial["participants"]))
  );
}

function requirePayload<A>(
  payload: unknown,
  guard: (payload: unknown) => payload is A,
  requirement: string,
): Effect.Effect<A> {
  if (guard(payload)) return Effect.succeed(payload);
  return Effect.dieMessage(
    `requirement middleware ${requirement}: incompatible RPC payload`,
  );
}

/**
 * The requirement obtains' service env as a `Context` snapshot, read once at
 * Layer build (per socket). Each requirement middleware impl
 * `Effect.provide`s it so the impl's Effect has no service `R` — the
 * `RpcMiddleware` contract is `Effect&lt;void, E>` with no context channel.
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
 * The Layer requirement every domain requirement impl shares: the obtain
 * services plus the connection manager (for the caller-peeking variant).
 */
type RequirementMiddlewareLayerR =
  | TaskServiceTag
  | ConversationServiceTag
  | MessageServiceTag
  | ConnectionManagerTag;

type MiddlewareFailure<Mw extends RpcMiddleware.TagClassAny> =
  Context.Tag.Service<Mw> extends RpcMiddleware.RpcMiddleware<
    unknown,
    infer Failure
  >
    ? Failure
    : never;

/**
 * Build a requirement impl Layer whose `derive` reads only the decoded `payload`
 * (no caller). Used for requirements that gate on pure params — e.g. `ConversationInTask`,
 * which the app-principal `app/conversation/*` methods declare, so its impl
 * must not peek the caller's agent id (the live arm is an `AppConnection`).
 */
function requirementMiddlewareLayer<
  Mw extends RpcMiddleware.TagClassAny,
  Value,
  In,
>(
  mw: Mw,
  derive: (payload: unknown) => Effect.Effect<In>,
  obtain: (input: In) => Effect.Effect<Value, MiddlewareFailure<Mw>, MwEnv>,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, RequirementMiddlewareLayerR> {
  return Layer.effect(
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
}

/**
 * Build a requirement impl Layer whose `derive` ALSO reads the caller's agent
 * id, peeked off the live arm. Used by the agent-principal requirements
 * (`ConversationSendAccess`, `TaskReadAccess`, `ContactPolicyAllowsReach`); the
 * peek dies on a non-agent arm, which is sound only because these requirements gate
 * agent-callable methods.
 */
function requirementMiddlewareLayerWithCaller<
  Mw extends RpcMiddleware.TagClassAny,
  Value,
  In,
>(
  mw: Mw,
  connId: ConnectionId,
  derive: (payload: unknown, callerAgentId: AgentId) => Effect.Effect<In>,
  obtain: (input: In) => Effect.Effect<Value, MiddlewareFailure<Mw>, MwEnv>,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, RequirementMiddlewareLayerR> {
  return Layer.effect(
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
}

function makeConversationInTaskLayer() {
  return requirementMiddlewareLayer(
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
}

function makeConversationSendAccessLayer(connId: ConnectionId) {
  return requirementMiddlewareLayerWithCaller(
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
}

function makeTaskReadAccessLayer(connId: ConnectionId) {
  return requirementMiddlewareLayerWithCaller(
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
}

function makeContactPolicyAllowsReachLayer(connId: ConnectionId) {
  return requirementMiddlewareLayerWithCaller(
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
          targetAgentIds: [
            ...new Set([
              ...p.invitedAgentIds,
              ...(p.initialConversation?.participants ?? []),
            ]),
          ],
        })),
      ),
    obtainContactPolicyAllowsReach,
  );
}

/**
 * Every per-socket requirement impl Layer, merged. The engine stacks each
 * requirement on the methods that declare it. `ConversationInTask` reads no
 * caller (pure params — it gates app-principal methods too); the rest peek the
 * caller's agent id.
 */
export const makeRequirementMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makeAgentPrincipalLayer(connId),
    makeAppPrincipalLayer(connId),
    makeAuthenticatedPrincipalLayer(connId),
    makeActiveAgentLayer(connId),
    makeConversationInTaskLayer(),
    makeConversationSendAccessLayer(connId),
    makeTaskReadAccessLayer(connId),
    makeContactPolicyAllowsReachLayer(connId),
  );
