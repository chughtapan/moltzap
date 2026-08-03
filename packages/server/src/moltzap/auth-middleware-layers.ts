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
 * narrowed arm off `ConnectionTag` (`agentArm`).
 *
 * Each domain requirement impl peeks the live arm when it needs the caller's
 * agent id, derives input from the decoded `payload`, and runs the requirement's
 * `obtain`. An obtain failure encodes against that requirement's own `failure`
 * schema.
 */
// safer-arch-ignore no-fat-orchestrator: This module is the assembly point for the complete protocol requirement Layer catalog used by each socket runtime.

import { Context, Effect, Layer, unsafeCoerce } from "effect";
import type { RpcMiddleware } from "@effect/rpc";
import {
  ActiveAgent,
  AuthenticatedAgent,
  type PrincipalRequirement,
  type AgentId,
} from "@moltzap/protocol/identity";
import {
  ConversationSendAccess,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import type { ConnectionId } from "@moltzap/protocol/socket";
import { ConnectionManagerTag } from "#socket";
import { ConversationServiceTag } from "#conversation";
import { MessageServiceTag } from "#message";
import { obtainConversationSendAccess } from "#conversation/requirements";
import { narrowByPolicy, peekLiveArm } from "./principal-gate.js";

/**
 * Read the caller's agent id off the live arm when a requirement derives from it.
 * @param manager Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @returns The caller agent id for result.
 */
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

type ConnectionManagerService = Parameters<typeof peekLiveArm>[0];

// ── Principal requirements ───────────────────────────────────────────────────

/**
 * Build a principal requirement impl Layer: peek the live arm and narrow it to
 * `narrowAs` (with `requireActiveAgent` for the `ActiveAgent` arm). The layer
 * provides nothing — it gates only, failing `Forbidden` on the wrong arm.
 * @param mw Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @param narrowAs Value supplied to the operation.
 * @param requireActiveAgent Value supplied to the operation.
 * @returns The principal layer result.
 */
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

// ── Domain requirements ──────────────────────────────────────────────────────

/** The requirement obtains' service env. */
type MwEnv = ConversationServiceTag | MessageServiceTag;

/** The options an `@effect/rpc` `RpcMiddleware` impl receives per request. */
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

/**
 * The requirement obtains' service env as a `Context` snapshot, read once at
 * Layer build (per socket). Each requirement middleware impl
 * `Effect.provide`s it so the impl's Effect has no service `R` — the
 * `RpcMiddleware` contract is `Effect&lt;void, E>` with no context channel.
 */
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

/**
 * The Layer requirement every domain requirement impl shares: the obtain
 * services plus the connection manager (for the caller-peeking variant).
 */
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

/**
 * Build a requirement impl Layer whose `derive` reads the caller's agent id,
 * peeked off the live arm. Used by the agent-principal requirements
 * (`ConversationSendAccess`); the peek dies on a non-agent arm, which is sound
 * only because these requirements gate agent-callable methods.
 * @param mw Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @param derive Value supplied to the operation.
 * @param obtain Value supplied to the operation.
 * @returns The requirement middleware layer with caller result.
 */
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

/**
 * Every per-socket requirement impl Layer, merged. The engine stacks each
 * requirement on the methods that declare it.
 * @param connId Value supplied to the operation.
 * @returns The created requirement middleware layers.
 */
export const makeRequirementMiddlewareLayers = (connId: ConnectionId) =>
  Layer.mergeAll(
    makeAuthenticatedAgentLayer(connId),
    makeActiveAgentLayer(connId),
    makeConversationSendAccessLayer(connId),
  );
