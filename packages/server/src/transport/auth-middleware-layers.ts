/**
 * @file The per-method `AuthMiddleware` impl Layers — one server-supplied
 * per-socket `Layer` over each protocol-owned `*AuthMw` descriptor
 * (`@moltzap/protocol` `auth-middleware.ts`).
 *
 * Each authenticated method carries ONE native `@effect/rpc` `RpcMiddleware`
 * whose `provides` is that method's `AuthContext` proof tag. The descriptor (the
 * proof Tag + the middleware Tag) is protocol-owned; the impl that resolves a
 * connection to its narrowed arm and runs each declared cap's derive/obtain is a
 * server concern, supplied here as a per-socket `Layer` over the descriptor.
 *
 * Every factory closes over the connection's `ConnectionId` (the per-socket key)
 * and requires `ConnectionManagerTag`; the cap-bearing factories additionally
 * require the cap obtains' service env (`MwEnv`). The impl peeks the live arm,
 * runs the #720 gate to the method's narrowed principal, then — for a cap-bearing
 * method — runs each declared cap's `derivePayload` → `obtain` WITH the principal
 * in scope and assembles the combined proof (the principal plus one field per
 * declared cap) keyed by each cap tag's identifier. A cap-obtain failure maps to
 * the coded wire
 * envelope the middleware `failure` schema carries (`toWireError`).
 *
 * Cap run order matches the binding-site weave (`messages.handlers.ts`):
 * FIRST-declared cap obtains FIRST, so a Forbidden rejection precedes a later
 * cap's state probe, and a DB-resolved field (e.g. `ConversationInTask`'s
 * membership) is available to the next cap.
 */
import { Context, Effect, Layer } from "effect";
import {
  CurrentPrincipal,
  ConversationInTask,
  TaskReadAccess,
  MessageSendPermission,
  ContactPolicyAllowsReach,
  MessagesSend,
  TaskConversationArchive,
  MessagesSendAuthMw,
  MessagesListAuthMw,
  TaskListAuthMw,
  TaskRequestAuthMw,
  TaskLeaveAuthMw,
  TaskConversationListAuthMw,
  AgentsLookupAuthMw,
  AgentsLookupByNameAuthMw,
  AgentsListAuthMw,
  ContactsListAuthMw,
  ContactsAddAuthMw,
  ContactsAcceptAuthMw,
  ContactsByIdAuthMw,
  DispatchRequestAuthMw,
  NetworkPingAuthMw,
  PresenceSubscribeAuthMw,
  TaskCloseAuthMw,
  TaskAddParticipantAuthMw,
  TaskRemoveParticipantAuthMw,
  TaskConversationCreateAuthMw,
  TaskConversationArchiveAuthMw,
  TaskConversationUnarchiveAuthMw,
  TaskConversationAddParticipantAuthMw,
  TaskConversationRemoveParticipantAuthMw,
  AppsRegisterAuthMw,
  DispatchesGetAuthMw,
  type AuthProof,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import {
  ConnectionManagerTag,
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../app/layers.js";
import {
  conversationInTaskForArchive,
  conversationInTaskForUnarchive,
  conversationInTaskForAddParticipant,
  conversationInTaskForRemoveParticipant,
  conversationInTaskForSend,
  conversationInTaskForList,
  messageSendPermissionMiddleware,
  taskReadAccessMiddleware,
  contactPolicyAllowsReachMiddleware,
} from "../app/capability-middlewares.js";
import { narrowByPolicy, peekLiveArm } from "./principal-gate.js";

/** The cap obtains' service env (`capability-middlewares.ts → MwEnv`). */
type MwEnv = TaskServiceTag | ConversationServiceTag | MessageServiceTag;

/** The agent-arm proof principal shape (`PrincipalForKind&lt;"agent">`). */
type AgentPrincipal = AuthProof<typeof MessagesSend>["principal"];
/** The app-arm proof principal shape (`PrincipalForKind&lt;"app">`). */
type AppPrincipal = AuthProof<typeof TaskConversationArchive>["principal"];

/**
 * Retype the gate output to the agent-arm proof principal. The gate already
 * rejected the wrong arm, so a non-agent `_tag` here is an impossible-state
 * defect.
 */
const asAgentPrincipal = (principal: {
  readonly _tag: string;
}): Effect.Effect<AgentPrincipal> =>
  principal._tag === "AgentContext"
    ? Effect.succeed(principal as AgentPrincipal)
    : Effect.dieMessage(
        `auth middleware: agent gate yielded non-agent arm ${principal._tag}`,
      );

/** Retype the gate output to the app-arm proof principal (impossible-state otherwise). */
const asAppPrincipal = (principal: {
  readonly _tag: string;
}): Effect.Effect<AppPrincipal> =>
  principal._tag === "AppContext"
    ? Effect.succeed(principal as AppPrincipal)
    : Effect.dieMessage(
        `auth middleware: app gate yielded non-app arm ${principal._tag}`,
      );

/**
 * Run ONE capability middleware: `derivePayload(params)` (reads
 * `CurrentPrincipal`) → `obtain`. Generic over the OWNING method's params type;
 * the caller provides `CurrentPrincipal` + `MwEnv` around the assembled chain.
 */
const runCap = <Params, Provides extends Context.Tag<any, any>, Input, Fail>(
  mw: {
    readonly provides: Provides;
    readonly derivePayload: (
      p: Params,
    ) => Effect.Effect<Input, never, CurrentPrincipal>;
    readonly obtain: (
      i: Input,
    ) => Effect.Effect<Context.Tag.Service<Provides>, Fail, MwEnv>;
  },
  params: Params,
): Effect.Effect<
  Context.Tag.Service<Provides>,
  Fail,
  MwEnv | CurrentPrincipal
> => mw.derivePayload(params).pipe(Effect.flatMap(mw.obtain));

/** Build the `MwEnv` Context snapshot the cap obtains run under. */
const mwEnv = Effect.gen(function* () {
  const taskService = yield* TaskServiceTag;
  const conversationService = yield* ConversationServiceTag;
  const messageService = yield* MessageServiceTag;
  return Context.empty().pipe(
    Context.add(TaskServiceTag, taskService),
    Context.add(ConversationServiceTag, conversationService),
    Context.add(MessageServiceTag, messageService),
  );
});

// ── Cap-less Layers (19 methods) ────────────────────────────────────────────
//
// A cap-less method's proof is `{ principal }`. The narrowed arm IS the proof's
// `PrincipalForKind<K>` (extra `AgentContext`/`AppContext` fields are fine for a
// read-only consumer). The gate runs the method's static policy
// (`callablePrincipal` + `requiresActive`), not a table lookup: each `*AuthMw`
// is already method-specific.

/**
 * Build a cap-less method's impl: peek the live arm, gate to the narrowed
 * principal, return `{ principal }` (the whole proof for a cap-less method). The
 * `manager` is captured once at Layer build; the returned function is the
 * per-request `@effect/rpc` middleware impl (payload-only, ignored here).
 */
const capLessImpl =
  (
    manager: Context.Tag.Service<typeof ConnectionManagerTag>,
    connId: ConnectionId,
    kind: "agent" | "app",
    requiresActive: boolean,
  ) =>
  () =>
    Effect.gen(function* () {
      const connection = yield* peekLiveArm(manager, connId);
      const narrowed = yield* narrowByPolicy(kind, requiresActive, connection);
      const principal =
        kind === "app"
          ? yield* asAppPrincipal(narrowed)
          : yield* asAgentPrincipal(narrowed);
      return { principal };
    }).pipe(Effect.withSpan("AuthMiddleware.capLess"));

const capLessLayer = <Mw extends Context.Tag<any, any>>(
  mw: Mw,
  connId: ConnectionId,
  kind: "agent" | "app",
  requiresActive: boolean,
): Layer.Layer<Context.Tag.Identifier<Mw>, never, ConnectionManagerTag> =>
  Layer.effect(
    mw,
    ConnectionManagerTag.pipe(
      Effect.map(
        (manager) =>
          capLessImpl(
            manager,
            connId,
            kind,
            requiresActive,
          ) as Context.Tag.Service<Mw>,
      ),
    ),
  );

const capLessAgentLayer = <Mw extends Context.Tag<any, any>>(
  mw: Mw,
  connId: ConnectionId,
  requiresActive: boolean,
) => capLessLayer(mw, connId, "agent", requiresActive);

const capLessAppLayer = <Mw extends Context.Tag<any, any>>(
  mw: Mw,
  connId: ConnectionId,
) => capLessLayer(mw, connId, "app", false);

// Agent-callable, cap-less. `requiresActive` mirrors each descriptor's policy:
// `task/leave` / `task/conversation/list` require an active agent; the lookups,
// listings, and ping do not (a pending agent may still resolve identities).
export const makeTaskListAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(TaskListAuthMw, connId, false);
export const makeTaskLeaveAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(TaskLeaveAuthMw, connId, true);
export const makeTaskConversationListAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(TaskConversationListAuthMw, connId, true);
export const makeAgentsLookupAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(AgentsLookupAuthMw, connId, false);
export const makeAgentsLookupByNameAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(AgentsLookupByNameAuthMw, connId, false);
export const makeAgentsListAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(AgentsListAuthMw, connId, false);
export const makeContactsListAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(ContactsListAuthMw, connId, false);
export const makeContactsAddAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(ContactsAddAuthMw, connId, false);
export const makeContactsAcceptAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(ContactsAcceptAuthMw, connId, false);
export const makeContactsByIdAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(ContactsByIdAuthMw, connId, false);
export const makeDispatchRequestAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(DispatchRequestAuthMw, connId, true);
export const makeNetworkPingAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(NetworkPingAuthMw, connId, false);
export const makePresenceSubscribeAuthMwLayer = (connId: ConnectionId) =>
  capLessAgentLayer(PresenceSubscribeAuthMw, connId, false);

// App-callable, cap-less.
export const makeTaskCloseAuthMwLayer = (connId: ConnectionId) =>
  capLessAppLayer(TaskCloseAuthMw, connId);
export const makeTaskAddParticipantAuthMwLayer = (connId: ConnectionId) =>
  capLessAppLayer(TaskAddParticipantAuthMw, connId);
export const makeTaskRemoveParticipantAuthMwLayer = (connId: ConnectionId) =>
  capLessAppLayer(TaskRemoveParticipantAuthMw, connId);
export const makeTaskConversationCreateAuthMwLayer = (connId: ConnectionId) =>
  capLessAppLayer(TaskConversationCreateAuthMw, connId);
export const makeAppsRegisterAuthMwLayer = (connId: ConnectionId) =>
  capLessAppLayer(AppsRegisterAuthMw, connId);
export const makeDispatchesGetAuthMwLayer = (connId: ConnectionId) =>
  capLessAppLayer(DispatchesGetAuthMw, connId);

// ── Cap-bearing Layers (7 methods) ──────────────────────────────────────────
//
// The proof is the principal plus one field per declared cap, keyed by each cap
// tag's identifier. Each cap's `derivePayload`/`obtain` runs with the gate's
// narrowed principal in scope (`CurrentPrincipal`) and the cap obtains' service
// env (`MwEnv`); a cap-obtain failure maps to the wire envelope.

/**
 * The caps an authenticated request runs, producing the cap-proof record.
 *
 * `payload` is the request's params AFTER the engine's schema decode (the
 * `@effect/rpc` server decodes against the member's `payloadSchema` and writes
 * the decoded value back before the middleware runs). Each `runCaps` re-widens
 * it to its method's decoded params type — a re-typing of an already-validated
 * value at the per-method boundary, not a wire decode.
 */
type RunCaps<Principal> = (
  principal: Principal,
  payload: unknown,
) => Effect.Effect<object, unknown, MwEnv | CurrentPrincipal>;

/** The per-method cap-bearing policy + cap-run closure a Layer is built from. */
interface CapBearingSpec<Mw extends Context.Tag<any, any>> {
  readonly mw: Mw;
  readonly connId: ConnectionId;
  readonly kind: "agent" | "app";
  readonly requiresActive: boolean;
  readonly span: string;
  readonly runCaps: RunCaps<AgentPrincipal | AppPrincipal>;
}

/**
 * Compose one cap-bearing method impl: gate to the narrowed principal, run the
 * method's caps with the principal plus `MwEnv` in scope, map a cap failure to
 * the wire envelope. `runCaps` returns the per-method cap-proof record; the impl
 * merges the principal in and the whole satisfies the method's `AuthProof`.
 */
const capBearingImpl =
  <Mw extends Context.Tag<any, any>>(
    spec: CapBearingSpec<Mw>,
    manager: Context.Tag.Service<typeof ConnectionManagerTag>,
    env: Context.Context<MwEnv>,
  ) =>
  ({ payload }: { readonly payload: unknown }) =>
    Effect.gen(function* () {
      const connection = yield* peekLiveArm(manager, spec.connId);
      const narrowed = yield* narrowByPolicy(
        spec.kind,
        spec.requiresActive,
        connection,
      );
      const principal =
        spec.kind === "app"
          ? yield* asAppPrincipal(narrowed)
          : yield* asAgentPrincipal(narrowed);
      // Cap obtains fail with their declared tagged-error instances; the engine
      // encodes them against the method's per-method error union (the
      // middleware `failure` schema). No coded-envelope projection.
      return yield* spec
        .runCaps(principal, payload)
        .pipe(
          Effect.provide(env),
          Effect.provideService(CurrentPrincipal, principal),
        );
    }).pipe(Effect.withSpan(spec.span));

/** Build a cap-bearing Layer from a {@link CapBearingSpec}. */
const capBearingLayer = <Mw extends Context.Tag<any, any>>(
  spec: CapBearingSpec<Mw>,
): Layer.Layer<
  Context.Tag.Identifier<Mw>,
  never,
  ConnectionManagerTag | MwEnv
> =>
  Layer.effect(
    spec.mw,
    Effect.gen(function* () {
      const manager = yield* ConnectionManagerTag;
      const env = yield* mwEnv;
      return capBearingImpl(spec, manager, env) as Context.Tag.Service<Mw>;
    }),
  );

/**
 * `messages/send` — agent + `[ConversationInTask, MessageSendPermission]`.
 * `ConversationInTask` resolves membership first; `MessageSendPermission`
 * probes against it.
 */
export const makeMessagesSendAuthMwLayer = (connId: ConnectionId) =>
  capBearingLayer({
    mw: MessagesSendAuthMw,
    connId,
    kind: "agent",
    requiresActive: true,
    span: "AuthMiddleware.messagesSend",
    runCaps: (principal, payload) =>
      Effect.gen(function* () {
        const params = payload as Parameters<
          typeof conversationInTaskForSend.derivePayload
        >[0];
        const conversationInTask = yield* runCap(
          conversationInTaskForSend,
          params,
        );
        const messageSendPermission = yield* runCap(
          messageSendPermissionMiddleware,
          params,
        );
        return {
          principal,
          [ConversationInTask.key]: conversationInTask,
          [MessageSendPermission.key]: messageSendPermission,
        };
      }).pipe(Effect.withSpan("AuthMiddleware.messagesSend.caps")),
  });

/** `messages/list` — agent + `[TaskReadAccess, ConversationInTask]`. */
export const makeMessagesListAuthMwLayer = (connId: ConnectionId) =>
  capBearingLayer({
    mw: MessagesListAuthMw,
    connId,
    kind: "agent",
    requiresActive: true,
    span: "AuthMiddleware.messagesList",
    runCaps: (principal, payload) =>
      Effect.gen(function* () {
        const params = payload as Parameters<
          typeof conversationInTaskForList.derivePayload
        >[0];
        const taskReadAccess = yield* runCap(taskReadAccessMiddleware, params);
        const conversationInTask = yield* runCap(
          conversationInTaskForList,
          params,
        );
        return {
          principal,
          [TaskReadAccess.key]: taskReadAccess,
          [ConversationInTask.key]: conversationInTask,
        };
      }).pipe(Effect.withSpan("AuthMiddleware.messagesList.caps")),
  });

/** `task/request` — agent + `[ContactPolicyAllowsReach]`. */
export const makeTaskRequestAuthMwLayer = (connId: ConnectionId) =>
  capBearingLayer({
    mw: TaskRequestAuthMw,
    connId,
    kind: "agent",
    requiresActive: true,
    span: "AuthMiddleware.taskRequest",
    runCaps: (principal, payload) =>
      Effect.gen(function* () {
        const params = payload as Parameters<
          typeof contactPolicyAllowsReachMiddleware.derivePayload
        >[0];
        const contactPolicyAllowsReach = yield* runCap(
          contactPolicyAllowsReachMiddleware,
          params,
        );
        return {
          principal,
          [ContactPolicyAllowsReach.key]: contactPolicyAllowsReach,
        };
      }).pipe(Effect.withSpan("AuthMiddleware.taskRequest.caps")),
  });

/**
 * The four `task/conversation/*` admin RPCs — app + `[ConversationInTask]`.
 * App-ownership of the task is gated separately in each handler body; the cap
 * proof carries only the conversation-in-task membership. The four share the
 * IDENTICAL impl shape, differing only in the per-method-typed cap middleware.
 */
const makeConversationAdminAuthMwLayer = <
  Mw extends Context.Tag<any, any>,
  Params,
>(
  mw: Mw,
  cap: {
    readonly provides: typeof ConversationInTask;
    readonly derivePayload: (
      p: Params,
    ) => Effect.Effect<
      Parameters<typeof conversationInTaskForArchive.obtain>[0],
      never,
      CurrentPrincipal
    >;
    readonly obtain: typeof conversationInTaskForArchive.obtain;
  },
  connId: ConnectionId,
) =>
  capBearingLayer({
    mw,
    connId,
    kind: "app",
    requiresActive: false,
    span: "AuthMiddleware.conversationAdmin",
    runCaps: (principal, payload) =>
      Effect.gen(function* () {
        const params = payload as Params;
        const conversationInTask = yield* runCap(cap, params);
        return { principal, [ConversationInTask.key]: conversationInTask };
      }).pipe(Effect.withSpan("AuthMiddleware.conversationAdmin.caps")),
  });

export const makeTaskConversationArchiveAuthMwLayer = (connId: ConnectionId) =>
  makeConversationAdminAuthMwLayer(
    TaskConversationArchiveAuthMw,
    conversationInTaskForArchive,
    connId,
  );
export const makeTaskConversationUnarchiveAuthMwLayer = (
  connId: ConnectionId,
) =>
  makeConversationAdminAuthMwLayer(
    TaskConversationUnarchiveAuthMw,
    conversationInTaskForUnarchive,
    connId,
  );
export const makeTaskConversationAddParticipantAuthMwLayer = (
  connId: ConnectionId,
) =>
  makeConversationAdminAuthMwLayer(
    TaskConversationAddParticipantAuthMw,
    conversationInTaskForAddParticipant,
    connId,
  );
export const makeTaskConversationRemoveParticipantAuthMwLayer = (
  connId: ConnectionId,
) =>
  makeConversationAdminAuthMwLayer(
    TaskConversationRemoveParticipantAuthMw,
    conversationInTaskForRemoveParticipant,
    connId,
  );
