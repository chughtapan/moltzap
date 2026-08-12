// safer-arch-ignore no-trivial-sink-file: This is the protocol socket adapter boundary; core app is intentionally its sole composition consumer.
// safer-arch-ignore no-fat-orchestrator: This module assembles the complete protocol requirement Layer catalog used by each socket runtime.
import type { Socket as EffectSocket } from "@effect/platform/Socket";
import type { RpcMiddleware } from "@effect/rpc";
import { Context, Effect, Layer, unsafeCoerce } from "effect";
import {
  ConversationSendAccess,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import {
  ActiveAgent,
  AuthenticatedAgent,
  type AgentId,
  type PrincipalRequirement,
} from "@moltzap/protocol/identity";
import {
  MoltZapServer,
  type ConnectionId,
  type MoltZapServerSession,
} from "@moltzap/protocol/socket";
import type { ServerHandlers } from "@moltzap/protocol/socket/catalog";

import type { ResolvedServices } from "#core";
import { ConversationServiceTag } from "#conversation";
import {
  agentConversationCreate,
  conversationList,
} from "#conversation/handlers";
import { obtainConversationSendAccess } from "#conversation/requirements";
import { agentsList } from "#identity/agents";
import { MessageServiceTag } from "#message";
import { messagesList, messagesSend } from "#message/handlers";
import { connectAgent } from "#network";
import { ConnectionManagerTag, ConnectionTag } from "#socket";
import { narrowByPolicy, peekLiveArm } from "./principal-gate.js";

type ConnectionManagerService = Parameters<typeof peekLiveArm>[0];

const callerAgentIdFor = (
  manager: ConnectionManagerService,
  connId: ConnectionId,
): Effect.Effect<AgentId> =>
  peekLiveArm(manager, connId).pipe(
    Effect.flatMap((connection) =>
      connection._tag === "AgentConnection"
        ? Effect.succeed(connection.auth.agentId)
        : Effect.dieMessage(
            `requirement middleware: agent-gated requirement reached on ${connection._tag} arm`,
          ),
    ),
  );

const principalLayer = <Mw extends RpcMiddleware.TagClassAny>(
  mw: Mw,
  connId: ConnectionId,
  narrowAs: PrincipalRequirement,
  requireActiveAgent: boolean,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, ConnectionManagerTag> =>
  unsafeCoerce(
    Layer.effect(
      mw,
      Effect.gen(function* () {
        const manager = yield* ConnectionManagerTag;
        return () =>
          peekLiveArm(manager, connId).pipe(
            Effect.flatMap((connection) =>
              narrowByPolicy(requireActiveAgent, connection, narrowAs),
            ),
            Effect.asVoid,
            Effect.withSpan(`requirement.${mw.key}`),
          );
      }),
    ),
  );

const makeAuthenticatedAgentLayer = (connId: ConnectionId) =>
  principalLayer(AuthenticatedAgent, connId, AuthenticatedAgent, false);

const makeActiveAgentLayer = (connId: ConnectionId) =>
  principalLayer(ActiveAgent, connId, AuthenticatedAgent, true);

type MwEnv = ConversationServiceTag | MessageServiceTag;

interface MwOptions {
  readonly clientId: number;
  readonly rpc: { readonly _tag: string };
  readonly payload: unknown;
}

interface SendParams {
  readonly conversationId: ConversationId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSendParams = (payload: unknown): payload is SendParams =>
  isRecord(payload) && typeof payload.conversationId === "string";

function requirePayload<A>(
  payload: unknown,
  guard: (payload: unknown) => payload is A,
  requirement: string,
): Effect.Effect<A> {
  if (guard(payload)) {
    return Effect.succeed(payload);
  }
  return Effect.dieMessage(
    `requirement middleware ${requirement}: incompatible RPC payload`,
  );
}

const mwEnv = Effect.gen(function* () {
  const conversationService = yield* ConversationServiceTag;
  const messageService = yield* MessageServiceTag;
  const manager = yield* ConnectionManagerTag;
  return Context.empty().pipe(
    Context.add(ConversationServiceTag, conversationService),
    Context.add(MessageServiceTag, messageService),
    Context.add(ConnectionManagerTag, manager),
  );
});

type RequirementMiddlewareLayerR =
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

const requirementMiddlewareLayerWithCaller = <
  Mw extends RpcMiddleware.TagClassAny,
  Value,
  In,
>(
  mw: Mw,
  connId: ConnectionId,
  derive: (payload: unknown, callerAgentId: AgentId) => Effect.Effect<In>,
  obtain: (input: In) => Effect.Effect<Value, MiddlewareFailure<Mw>, MwEnv>,
): Layer.Layer<
  Context.Tag.Identifier<Mw>,
  never,
  RequirementMiddlewareLayerR
> =>
  unsafeCoerce(
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
    ),
  );

const makeConversationSendAccessLayer = (connId: ConnectionId) =>
  requirementMiddlewareLayerWithCaller(
    ConversationSendAccess,
    connId,
    (payload, senderAgentId) =>
      requirePayload(payload, isSendParams, ConversationSendAccess.key).pipe(
        Effect.map((p) => ({
          conversationId: p.conversationId,
          senderAgentId,
        })),
      ),
    obtainConversationSendAccess,
  );

const makeRequirementMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makeAuthenticatedAgentLayer(connId),
    makeActiveAgentLayer(connId),
    makeConversationSendAccessLayer(connId),
  );

const serverHandlers: ServerHandlers = {
  "agent/network/connect": connectAgent,
  "agent/identity/agents/list": agentsList,
  "agent/message/send": messagesSend,
  "agent/message/list": messagesList,
  "agent/conversation/list": conversationList,
  "agent/conversation/create": agentConversationCreate,
} as const;

const makeConnectionTagLayer = (
  connId: ConnectionId,
): Layer.Layer<ConnectionTag, never, ConnectionManagerTag> =>
  Layer.effect(
    ConnectionTag,
    ConnectionManagerTag.pipe(
      Effect.flatMap((manager) => peekLiveArm(manager, connId)),
    ),
  );

/**
 * Creates moltzap socket handler.
 * @param options Options that control the operation.
 * @param options.services Value supplied to the operation.
 * @returns The created moltzap socket handler.
 */
export function makeMoltzapSocketHandler(options: {
  readonly services: ResolvedServices;
}) {
  const protocolServer = new MoltZapServer({
    handlers: serverHandlers,
    authLayer: makeRequirementMiddlewareLayers,
    connectionLayer: makeConnectionTagLayer,
    onOpen: (session) =>
      options.services.connections.addUnauthenticated(
        session.connId,
        session.originator,
      ),
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lifecycle callback is invoked after module initialization.
    onClose: (...[, session]) => closeSocketSession(session, options),
  });
  return (socket: EffectSocket) => protocolServer.handleSocket(socket);
}

const closeSocketSession = Effect.fn("socket.closeSession")(function* (
  session: MoltZapServerSession,
  options: {
    readonly services: ResolvedServices;
  },
) {
  const removed = yield* options.services.connections.removeAndReturn(
    session.connId,
  );
  if (removed !== undefined && removed._tag === "AgentConnection") {
    const authCtx = removed.auth;
    yield* options.services.agentEndpointResolver.remove(
      authCtx.agentId,
      session.connId,
    );
  }
});
