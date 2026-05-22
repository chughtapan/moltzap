import type { Db } from "../db/client.js";
import { sendRpcToClient } from "../transport/connection.js";
import type {
  ConnectionManager,
  MoltZapConnection,
} from "../transport/connection.js";
import type {
  AnyTaskCallbackRpcDefinition,
  AppManifest,
  DispatchId,
  LeaseId,
  LogicalClock,
  ParamsOf,
  Part,
  ResultOf,
} from "@moltzap/protocol";
import { DispatchAuthorize } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import type {
  AppId,
  ConversationId,
  MessageId,
  TaskId,
} from "@moltzap/protocol/task";
import {
  type DispatchAdmissionResult,
  type MessageAuthorizeContext,
  type MessageAuthorizeResult,
  type DispatchAuthorizeContext,
} from "./hooks.js";
import {
  AppRegistry,
  type AppRegistration,
  type InProcessHooks,
} from "./app-registration.js";
import { MessagesAuthorize } from "@moltzap/protocol";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect, Either, Match, Option } from "effect";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";
import {
  lookupAppForConversation,
  type ConversationAppLookup,
} from "./conversation-app-lookup.js";
import { NetworkSendServiceTag } from "./layers.js";
import type { LeaseRegistry, LeaseVerdict } from "./lease-registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True if the registration opts in to handling `messages/authorize`.
 * InProcess: the optional `messageAuthorize` hook is set. Remote:
 * the manifest declares `hooks.message_authorize`. Otherwise the
 * server uses the default forward policy.
 */
function hasMessageAuthorizeHook(entry: AppRegistration): boolean {
  if (entry._tag === "InProcess") {
    return entry.messageAuthorize !== undefined;
  }
  return entry.manifest.hooks?.message_authorize !== undefined;
}

const DEFAULT_APP_HOOK_TIMEOUT_MS = 5000;
const EMPTY_TASK_ID = "" as TaskId;
// Placeholder app id used by the dispatchBindingForLookup default-grant
// branch; the binding is consumed only by the registry mint path, which
// never re-uses it for an `isAppConnection` check. The empty-string
// sentinel mirrors `EMPTY_TASK_ID` and the moderator-conn-id default
// below — see `dispatchBindingForLookup`.
const EMPTY_APP_ID = "" as AppId;
const EMPTY_CONNECTION_ID = "" as ConnectionId;

export interface ContactService {
  areInContact(userIdA: string, userIdB: string): Effect.Effect<boolean, never>;
}

/**
 * Structural slice of {@link ConversationService} that AppHost depends
 * on for the #529 reshape deny arm. Defined locally rather than
 * importing the concrete service to avoid a circular import — the
 * layer order has ConversationService depending on AppHost.
 */
interface ConversationServiceForRemove {
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
    requesterAgentId: AgentId,
  ): Effect.Effect<void, unknown, NetworkSendServiceTag>;
}

class RemoteHookError extends Data.TaggedError("RemoteHookError")<{
  readonly appId: AppId;
  readonly method: string;
  readonly connectionId: ConnectionId;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

type PendingDispatchMessage = Readonly<{
  messageId: MessageId;
  conversationId: ConversationId;
  senderAgentId: AgentId;
  createdAt: string;
  receivedAt: string;
  clock?: LogicalClock;
  parts?: Part[];
}>;

interface EnqueueDispatchRequestArgs {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: Part[];
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly clock?: LogicalClock;
  readonly pending?: ReadonlyArray<PendingDispatchMessage>;
}

interface DispatchBindingContext {
  readonly appId: AppId;
  readonly taskId: TaskId;
  readonly moderatorConnectionId: ConnectionId;
}

interface DispatchRoundTripParams {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: Part[];
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly clock?: LogicalClock;
  readonly pending?: ReadonlyArray<PendingDispatchMessage>;
  readonly moderatorConnectionId: ConnectionId;
}

type AppBoundConversationLookup = Extract<
  ConversationAppLookup,
  { readonly _tag: "AppBound" }
>;

type NonAppBoundConversationLookup = Exclude<
  ConversationAppLookup,
  AppBoundConversationLookup
>;

function dispatchVerdictToLeaseVerdict(
  verdict: DispatchAdmissionResult,
): LeaseVerdict {
  switch (verdict.decision) {
    case "grant":
      return verdict.leaseTimeoutMs === undefined
        ? { _tag: "grant" }
        : { _tag: "grant", leaseTimeoutMs: verdict.leaseTimeoutMs };
    case "deny":
      return verdict.reason === undefined
        ? { _tag: "deny" }
        : { _tag: "deny", reason: verdict.reason };
    case "hold":
      return verdict.reason === undefined
        ? { _tag: "hold" }
        : { _tag: "hold", reason: verdict.reason };
  }
}

export class AppHost {
  /**
   * Single source of truth for app registrations. Each `AppId` maps to
   * exactly ONE `AppRegistration` — either an `InProcess` variant
   * (boot-installed, e.g. DEFAULT_APP_ID) or a `Wire` variant (a remote
   * app that called `apps/register` over the wire). The tagged union
   * makes the "registered in both shapes" and "registered manifest
   * without a hook" states unrepresentable; see
   * `./app-registration.ts` for the type definition.
   */
  private apps = new AppRegistry();

  private contactService: ContactService | null = null;

  /**
   * Optional lease registry for the #529 reshape surface.
   * Set post-construction by the layer wiring (see {@link setLeaseRegistry}).
   * Consumed exclusively by `enqueueDispatchRequest`. Kept optional so
   * existing tests that construct AppHost directly without a registry
   * still work.
   */
  private leaseRegistry: LeaseRegistry | null = null;

  /**
   * Optional conversation service for the #529 reshape additive deny
   * arm. Wired post-construction by the server layer (see
   * {@link setConversationService}). Used by the forked moderator
   * round-trip to call `removeParticipant` on verdict-deny / synthesized
   * timeout-deny — the architect §3 state-machine rule "On `deny`
   * verdict, registry calls `conversationService.removeParticipant(...)`".
   * Synthesized infra-hold (no hook registered) does NOT call
   * removeParticipant — that is the prereq-2 hold case.
   */
  private conversationService: ConversationServiceForRemove | null = null;

  constructor(
    private db: Db,
    private connections: ConnectionManager,
  ) {}

  /** Wire the lease registry post-construction. */
  setLeaseRegistry(registry: LeaseRegistry): void {
    this.leaseRegistry = registry;
  }

  /**
   * Wire the conversation service post-construction. The server layer
   * sets this after both AppHost and ConversationService have been
   * constructed (the layer order has ConversationService depending on
   * AppHost, so the inverse cannot be a constructor arg without
   * breaking the cycle).
   */
  setConversationService(svc: ConversationServiceForRemove): void {
    this.conversationService = svc;
  }

  /** Test-only / handler-side accessor. */
  getLeaseRegistry(): LeaseRegistry | null {
    return this.leaseRegistry;
  }

  /**
   * Install an app whose hooks run in-process. The boot-installed
   * `DEFAULT_APP_ID` is the only production caller; tests that need a
   * custom hook MUST go through {@link registerRemoteApp} + an
   * `onAppCallback` handler instead.
   *
   * Throws if `appId` is already wire-registered (a boot-installed app
   * MUST NOT be hijacked by a remote registration).
   */
  installInProcessApp(manifest: AppManifest, hooks: InProcessHooks): void {
    this.apps.installInProcess(manifest, hooks);
    Effect.runFork(
      Effect.logInfo("In-process app installed").pipe(
        Effect.annotateLogs({ appId: manifest.appId }),
      ),
    );
  }

  /**
   * Register an app whose hooks run in a remote process — typically a
   * WebSocket client that just called `apps/register`. Returns `false`
   * (and the AppsRegister handler MUST surface a typed `ForbiddenError`)
   * when the app is already in-process; otherwise overwrites any prior
   * wire registration (the connection may have reconnected).
   *
   * `dispatch/authorize` and `messages/authorize` dispatch via
   * {@link sendRpcToClient}; verdicts decode through the schemas in
   * `hooks.ts` and feed the same fail-closed envelope used elsewhere.
   * Disconnect: every pending Deferred fails with `NotConnectedError`
   * via the connection's Scope finalizer; the registration keeps
   * pointing at the dead id and dispatches stay fail-closed until
   * `unregisterRemoteApp` runs.
   */
  registerRemoteApp(
    manifest: AppManifest,
    connectionId: ConnectionId,
  ): boolean {
    const ok = this.apps.registerRemote(manifest, connectionId);
    if (ok) {
      Effect.runFork(
        Effect.logInfo("Remote app registered").pipe(
          Effect.annotateLogs({
            appId: manifest.appId,
            connectionId,
          }),
        ),
      );
    }
    return ok;
  }

  /**
   * Drop a wire-app registration on connection close. Idempotent —
   * no-op if absent or if the entry is in-process (boot-installed apps
   * stay installed for the server's lifetime).
   *
   * Existing in-flight admission Deferreds are unaffected — they're
   * owned by the connection's pending map and resolved either by the
   * response router (if the app replies) or by the Scope finalizer on
   * disconnect.
   */
  unregisterRemoteApp(appId: AppId): void {
    if (this.apps.unregisterRemote(appId)) {
      Effect.runFork(
        Effect.logInfo("Wire app unregistered").pipe(
          Effect.annotateLogs({ appId }),
        ),
      );
    }
  }

  /**
   * TM-authority gate: returns true iff `callerConnId` IS the
   * connection currently registered as the wire app for `appId` —
   * i.e. the caller's WebSocket is the app's `apps/register` channel.
   * In-process registrations have no connection and always return
   * false here.
   */
  isAppConnection(appId: AppId, callerConnId: ConnectionId): boolean {
    const entry = this.apps.get(appId);
    return (
      entry !== undefined &&
      entry._tag === "Remote" &&
      entry.connectionId === callerConnId
    );
  }

  getManifest(appId: AppId): AppManifest | undefined {
    return this.apps.get(appId)?.manifest;
  }

  setContactService(checker: ContactService): void {
    this.contactService = checker;
  }

  /**
   * Read-side accessor used by peer services (notably
   * {@link ConversationService}) that must consult the same contact policy
   * AppHost uses for app-session admission. Returns `null` when no policy
   * is wired — callers treat that as "allow all" to preserve dev-mode
   * defaults.
   */
  getContactService(): ContactService | null {
    return this.contactService;
  }

  /**
   * Mint a lease for an admission request, return
   * the ack synchronously, fork the moderator round-trip in the
   * background. The forked fiber resolves the lease via the registry,
   * which fires `dispatch/release` to the recipient.
   *
   * Inputs:
   * - `recipientConnectionId` — the calling client's WS connection.
   * - `senderAgentId` etc — same shape as `runAuthorizeDispatch`.
   *
   * Side-effects via the registry:
   *  - `NoAppSession` / `ConversationNotFound`: synthesize `grant`,
   *    resolve immediately. Recipient sees `dispatch/release{grant}`
   *    after the ack lands.
   *  - `ConversationArchived`: synthesize `deny{conversation_archived}`.
   *  - `AppBound` with no hook: synthesize `hold{moderator_unavailable}`
   *    (load-bearing — does NOT call `removeParticipant`).
   *  - `AppBound` with hook: forked round-trip; verdict-deny + timeout-
   *    deny call `resolve(deny)` and the caller is responsible for
   *    `removeParticipant` via the standard verdict-deny path.
   *
   * Returns immediately with `{leaseId, dispatchId}` (or fails closed
   * via `LeaseRegistry not wired` defect if the registry hasn't been
   * configured — caller should always wire it via {@link setLeaseRegistry}).
   */
  enqueueDispatchRequest(
    args: EnqueueDispatchRequestArgs,
  ): Effect.Effect<
    { leaseId: LeaseId; dispatchId: DispatchId },
    never,
    NetworkSendServiceTag
  > {
    const registry = this.leaseRegistry;
    if (!registry) {
      return Effect.dieMessage(
        "AppHost.enqueueDispatchRequest: LeaseRegistry not wired (call setLeaseRegistry post-construction)",
      );
    }
    return catchSqlErrorAsDefect(
      this.enqueueDispatchRequestEffect(registry, args),
    );
  }

  private enqueueDispatchRequestEffect(
    registry: LeaseRegistry,
    args: EnqueueDispatchRequestArgs,
  ): Effect.Effect<
    { leaseId: LeaseId; dispatchId: DispatchId },
    SqlError,
    NetworkSendServiceTag
  > {
    return Effect.gen(this, function* () {
      const lookup = yield* lookupAppForConversation(
        this.db,
        args.conversationId,
      );
      const binding = this.dispatchBindingForLookup(lookup);
      const minted = yield* registry.mint({
        recipientAgentId: args.recipientAgentId,
        recipientConnectionId: args.recipientConnectionId,
        moderatorConnectionId: binding.moderatorConnectionId,
        taskId: binding.taskId,
        conversationId: args.conversationId,
        appId: binding.appId,
      });

      yield* this.attachDispatchRoundTripFiber(
        registry,
        minted.leaseId,
        lookup,
        {
          conversationId: args.conversationId,
          recipientAgentId: args.recipientAgentId,
          messageId: args.messageId,
          senderAgentId: args.senderAgentId,
          parts: args.parts,
          attempt: args.attempt,
          receivedAt: args.receivedAt,
          clock: args.clock,
          pending: args.pending,
          moderatorConnectionId: binding.moderatorConnectionId,
        },
      );
      return minted;
    });
  }

  private dispatchBindingForLookup(
    lookup: ConversationAppLookup,
  ): DispatchBindingContext {
    if (lookup._tag !== "AppBound") {
      return {
        appId: EMPTY_APP_ID,
        taskId: EMPTY_TASK_ID,
        moderatorConnectionId: EMPTY_CONNECTION_ID,
      };
    }
    const entry = this.apps.get(lookup.appId);
    return {
      appId: lookup.appId,
      taskId: lookup.taskId,
      moderatorConnectionId:
        entry?._tag === "Remote" ? entry.connectionId : EMPTY_CONNECTION_ID,
    };
  }

  private attachDispatchRoundTripFiber(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: ConversationAppLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    return Effect.gen(this, function* () {
      const fiber = yield* Effect.forkDaemon(
        this.runForkedDispatchRoundTrip(registry, leaseId, lookup, params),
      );
      yield* registry.attachRoundTripFiber(leaseId, fiber);
    });
  }

  /**
   * Forked moderator round-trip that resolves the lease. Invoked off the
   * critical path of `enqueueDispatchRequest` so the ack returns before
   * any moderator latency. Errors (timeout, throw, RPC failure, decode
   * error) collapse into typed-deny verdicts via the existing envelope
   * (`wrapHookEffectWithEnvelope`).
   */
  private runForkedDispatchRoundTrip(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: ConversationAppLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    return catchSqlErrorAsDefect(
      lookup._tag === "AppBound"
        ? this.runAppBoundDispatchRoundTrip(registry, leaseId, lookup, params)
        : this.resolveNonAppBoundDispatch(registry, leaseId, lookup),
    );
  }

  private resolveNonAppBoundDispatch(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: NonAppBoundConversationLookup,
  ): Effect.Effect<void, never> {
    switch (lookup._tag) {
      case "ConversationArchived":
        return this.resolveDispatchLease(registry, leaseId, {
          _tag: "deny",
          reason: "conversation_archived",
        });
      case "ConversationNotFound":
      case "NoAppSession":
        return this.resolveDispatchLease(registry, leaseId, { _tag: "grant" });
    }
  }

  private runAppBoundDispatchRoundTrip(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, SqlError, NetworkSendServiceTag> {
    if (!this.hasDispatchAuthorizeHook(lookup.appId)) {
      return this.resolveDispatchLease(registry, leaseId, {
        _tag: "hold",
        reason: "moderator_unavailable",
      });
    }

    return Effect.gen(this, function* () {
      const ctx = yield* this.dispatchAuthorizeContext(lookup, params);
      const verdict = yield* this.dispatchAuthorizeHook(lookup.appId, ctx);
      yield* this.resolveDispatchLease(
        registry,
        leaseId,
        dispatchVerdictToLeaseVerdict(verdict),
      );
      yield* this.removeDeniedParticipant(verdict, params);
    });
  }

  private hasDispatchAuthorizeHook(appId: AppId): boolean {
    return this.apps.has(appId);
  }

  private dispatchAuthorizeContext(
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<DispatchAuthorizeContext, SqlError> {
    return Effect.gen(this, function* () {
      const ownerId = yield* this.recipientOwnerId(params.recipientAgentId);
      return {
        conversationId: params.conversationId,
        recipient: { agentId: params.recipientAgentId, ownerId },
        message: {
          id: params.messageId,
          senderAgentId: params.senderAgentId,
          parts: params.parts,
        },
        taskId: lookup.taskId,
        appId: lookup.appId,
        attempt: params.attempt ?? 0,
        receivedAt: params.receivedAt,
        clock: params.clock,
        pending: params.pending,
        signal: new AbortController().signal,
      };
    });
  }

  private recipientOwnerId(agentId: AgentId): Effect.Effect<string, SqlError> {
    return takeFirstOption(
      this.db
        .selectFrom("agents")
        .select("owner_user_id")
        .where("id", "=", agentId),
    ).pipe(
      Effect.map((agentOpt) =>
        Option.match(agentOpt, {
          onNone: () => "",
          onSome: (agent) => agent.owner_user_id ?? "",
        }),
      ),
    );
  }

  private resolveDispatchLease(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    verdict: LeaseVerdict,
  ): Effect.Effect<void, never> {
    return registry.resolve(leaseId, verdict).pipe(Effect.ignore);
  }

  /**
   * On verdict-deny, evict the recipient from the conversation. Uses
   * the moderator's WS auth identity (the registered remote app's
   * `auth.agentId`) as the requester. Skips when no moderator
   * connection or no conversation service is wired.
   */
  private removeDeniedParticipant(
    verdict: DispatchAdmissionResult,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    if (verdict.decision !== "deny") return Effect.void;
    const svc = this.conversationService;
    const moderatorAgentId = this.moderatorAgentIdFromConn(
      params.moderatorConnectionId,
    );
    if (svc === null || moderatorAgentId === null) return Effect.void;
    return svc
      .removeParticipant(
        params.conversationId,
        params.recipientAgentId,
        moderatorAgentId,
      )
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("deny removeParticipant failed").pipe(
            Effect.annotateLogs({
              conversationId: params.conversationId,
              recipientAgentId: params.recipientAgentId,
              cause: String(cause),
            }),
          ),
        ),
      );
  }

  private moderatorAgentIdFromConn(connectionId: ConnectionId): AgentId | null {
    if (connectionId === EMPTY_CONNECTION_ID) return null;
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.auth) return null;
    return conn.auth.agentId as AgentId;
  }

  /**
   * Dispatch a `dispatch/authorize` hook. In-process / remote choice is
   * made INSIDE the helper; callers see one signature and one return
   * type. Returns `{ decision: "grant" }` when no hook is registered.
   * Fail-closed on timeout / handler error / RPC failure per architect
   * plan §3.4.
   */
  private dispatchAuthorizeHook(
    appId: AppId,
    ctx: DispatchAuthorizeContext,
  ): Effect.Effect<DispatchAdmissionResult, never> {
    const entry = this.apps.get(appId);
    if (entry === undefined) {
      return Effect.succeed({ decision: "grant" as const });
    }
    const timeoutMs =
      entry.manifest.hooks?.dispatch_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw: this.dispatchAuthorizeRaw(entry, ctx),
      timeoutMs,
      timeoutLogMessage: "dispatch/authorize timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "dispatch/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => ({
        decision: "deny" as const,
        reason: "timeout",
      }),
      onError: () => ({
        decision: "deny" as const,
        reason: "dispatch/authorize error",
      }),
    });
  }

  private dispatchAuthorizeRaw(
    entry: AppRegistration,
    ctx: DispatchAuthorizeContext,
  ): Effect.Effect<DispatchAdmissionResult, Error> {
    return Match.value(entry).pipe(
      Match.tag("InProcess", (reg) =>
        this.runInProcessHookEffect<
          DispatchAuthorizeContext,
          DispatchAdmissionResult
        >((ctxWithSignal) => reg.dispatchAuthorize(ctxWithSignal), ctx),
      ),
      Match.tag("Remote", (reg) =>
        this.runRemoteHookEffect({
          appId: reg.appId,
          definition: DispatchAuthorize,
          connectionId: reg.connectionId,
          params: this.authorizeDispatchParamsForWire(ctx),
        }).pipe(Effect.map((envelope) => envelope.admission)),
      ),
      Match.exhaustive,
    );
  }

  /**
   * Resolve the per-message fan-out verdict for a `messages/send`.
   * Looks up the registered handler by `appId`, dispatches either the
   * in-process `MessageAuthorizeHook` or the remote
   * `messages/authorize` S→C RPC, applies the uniform fail-closed
   * envelope, and returns a verdict the
   * `MessageService.sendCommit` caller can switch on.
   *
   * Fail-closed posture (mirrors `runAuthorizeDispatch`): timeout / RPC
   * error / handler throw / decode failure all synthesize `Block { reason:
   * "tm_unreachable" }` (or `"messages/authorize timeout"` /
   * `"messages/authorize error"`, matching `dispatch/authorize`'s
   * wording where the cause is known).
   *
   * Default policy when no hook is registered: `Forward { recipients:
   * participants \ sender }` — preserves today's broadcast behavior
   * with zero wire chatter.
   */
  runMessageAuthorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const entry = this.apps.get(appId);
    if (entry === undefined || !hasMessageAuthorizeHook(entry)) {
      return this.defaultMessageAuthorize(ctx);
    }

    const timeoutMs =
      entry.manifest.hooks?.message_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    return this.wrapHookEffectWithEnvelope<MessageAuthorizeResult>({
      raw: this.messageAuthorizeRaw(entry, ctx),
      timeoutMs,
      timeoutLogMessage: "messages/authorize timed out",
      timeoutLogContext: {
        taskId,
        appId,
        timeoutMs,
      },
      errorLogMessage: "messages/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => ({
        decision: "Block" as const,
        reason: "tm_unreachable",
      }),
      onError: () => ({
        decision: "Block" as const,
        reason: "tm_unreachable",
      }),
    });
  }

  private defaultMessageAuthorize(
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("conversation_participants")
          .select("agent_id")
          .where("conversation_id", "=", ctx.conversationId);
        const recipients = rows
          .map((r) => r.agent_id as AgentId)
          .filter((a) => a !== ctx.message.senderAgentId);
        return {
          decision: "Forward" as const,
          recipients,
        } satisfies MessageAuthorizeResult;
      }),
    );
  }

  private messageAuthorizeRaw(
    entry: AppRegistration,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, Error> {
    return Match.value(entry).pipe(
      Match.tag("InProcess", (reg) => {
        // Caller (`runMessageAuthorize`) already short-circuited the
        // undefined case to `defaultMessageAuthorize`; the `!` here is
        // safe and load-bearing for the exhaustive match.
        const hook = reg.messageAuthorize!;
        return this.runInProcessHookEffect<
          MessageAuthorizeContext,
          MessageAuthorizeResult
        >((ctxWithSignal) => hook(ctxWithSignal), ctx);
      }),
      Match.tag("Remote", (reg) =>
        this.runRemoteHookEffect({
          appId: reg.appId,
          definition: MessagesAuthorize,
          connectionId: reg.connectionId,
          params: this.messageAuthorizeParamsForWire(ctx),
        }).pipe(Effect.map((envelope) => envelope.verdict)),
      ),
      Match.exhaustive,
    );
  }

  /**
   * Wire-shape params for `messages/authorize`. Mirrors
   * {@link authorizeDispatchParamsForWire}: strip `signal`, then
   * conditionally include optional fields so the TypeBox schema's
   * `additionalProperties: false` doesn't reject `undefined`.
   */
  private messageAuthorizeParamsForWire(
    ctx: MessageAuthorizeContext,
  ): ParamsOf<typeof MessagesAuthorize> {
    const wire = this.contextForWire(ctx);
    return {
      taskId: wire.taskId,
      appId: wire.appId,
      conversationId: wire.conversationId,
      message: {
        id: wire.message.id,
        senderAgentId: wire.message.senderAgentId,
        ...(wire.message.parts !== undefined
          ? { parts: wire.message.parts }
          : {}),
      },
      ...(wire.receivedAt !== undefined ? { receivedAt: wire.receivedAt } : {}),
      ...(wire.clock !== undefined ? { clock: wire.clock } : {}),
    };
  }

  /** Clear in-memory state. Called on shutdown. */
  destroy(): void {
    // Wire registrations only — InProcess apps (DEFAULT_APP_ID and
    // friends) stay installed for the lifetime of the server process,
    // so the AppRegistry retains them across `destroy()` calls. The
    // wire-side connections close via the WS layer's own scope
    // finalizer; AppRegistry has no per-connection cleanup hook.
  }

  // ── Uniform hook dispatch (in-process + remote) ────────────────────
  //
  // Per architect plan §3.4: every hook returns `Effect<Verdict, never>`
  // regardless of source. The branching between in-process and remote is
  // INSIDE the dispatch helpers; call sites observe one type. Failure
  // modes (timeout, throw, RPC error, NotConnectedError, decode failure)
  // collapse into fail-closed verdicts (`deny`).

  /**
   * Strip non-wire-safe fields from a hook context so it can be sent over
   * the task-callback RPC. Currently the only such field is
   * `signal: AbortSignal`, which has meaning only in-process. Returns a
   * new object — does not mutate `ctx`.
   */
  private contextForWire<C extends { signal?: AbortSignal }>(
    ctx: C,
  ): Omit<C, "signal"> {
    // Type-checker insists we elide `signal` explicitly rather than using
    // a destructure-discard, because `signal` is optional in the constraint
    // but always present in the concrete contexts.
    const out = { ...ctx } as { signal?: AbortSignal } & Omit<C, "signal">;
    delete out.signal;
    return out;
  }

  private authorizeDispatchParamsForWire(
    ctx: DispatchAuthorizeContext,
  ): ParamsOf<typeof DispatchAuthorize> {
    const wire = this.contextForWire(ctx);
    return {
      taskId: wire.taskId,
      appId: wire.appId,
      conversationId: wire.conversationId,
      recipient: wire.recipient,
      message: {
        id: wire.message.id,
        senderAgentId: wire.message.senderAgentId,
        ...(wire.message.parts !== undefined
          ? { parts: wire.message.parts }
          : {}),
      },
      attempt: wire.attempt,
      ...(wire.receivedAt !== undefined ? { receivedAt: wire.receivedAt } : {}),
      ...(wire.clock !== undefined ? { clock: wire.clock } : {}),
      ...(wire.pending !== undefined
        ? {
            pending: wire.pending.map((pending) => ({
              messageId: pending.messageId,
              conversationId: pending.conversationId,
              senderAgentId: pending.senderAgentId,
              createdAt: pending.createdAt,
              receivedAt: pending.receivedAt,
              ...(pending.clock !== undefined ? { clock: pending.clock } : {}),
              ...(pending.parts !== undefined ? { parts: pending.parts } : {}),
            })),
          }
        : {}),
    };
  }

  /**
   * Run an in-process Promise-returning hook under an `AbortController`
   * tied to fiber interrupts (e.g., from `Effect.timeout` upstream). The
   * controller is wired so:
   *   - timeout fires → fiber interrupts → `Effect.onInterrupt` aborts
   *   - hook throws / rejects → `tapErrorCause` aborts
   * preserving the abort-on-timeout / abort-on-throw guarantees.
   *
   * Returns the raw verdict in the success channel and a typed `Error`
   * in the failure channel (so the dispatch envelope's `catchAll` can
   * synthesize the fail-closed verdict).
   */
  private runInProcessHookEffect<Ctx, T>(
    handler: (ctx: Ctx & { signal: AbortSignal }) => T | Promise<T>,
    ctx: Ctx,
  ): Effect.Effect<T, Error> {
    return Effect.gen(function* () {
      const controller = new AbortController();
      return yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(handler({ ...ctx, signal: controller.signal })),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.tapErrorCause(() => Effect.sync(() => controller.abort())),
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
      );
    });
  }

  /**
   * Dispatch a server-initiated RPC to a remote app's connection and
   * decode the verdict. Returns the typed verdict in the success channel;
   * any failure (`NotConnectedError`, RPC response error, socket error,
   * schema decode failure, missing connection) lands in the failure
   * channel for the dispatch envelope to map to fail-closed.
   *
   * Result decoding happens in `sendRpcToClient`, where the descriptor
   * that constructed the frame validates the response against its TypeBox
   * result schema before this method can observe a value.
   */
  private runRemoteHookEffect<D extends AnyTaskCallbackRpcDefinition>(opts: {
    appId: AppId;
    definition: D;
    connectionId: ConnectionId;
    params: ParamsOf<D>;
  }): Effect.Effect<ResultOf<D>, RemoteHookError> {
    return Effect.gen(this, function* () {
      const method = opts.definition.name;
      const conn: MoltZapConnection | undefined = this.connections.get(
        opts.connectionId,
      );
      if (!conn) {
        // Stale registration: the remote app's connection has already
        // gone away. Treat identically to mid-flight `NotConnectedError`
        // so the dispatch envelope folds it into fail-closed.
        return yield* Effect.fail(
          new RemoteHookError({
            appId: opts.appId,
            method,
            connectionId: opts.connectionId,
            reason: `Remote app ${opts.appId} connection ${opts.connectionId} is gone`,
          }),
        );
      }
      return yield* Either.match(
        yield* Effect.either(
          sendRpcToClient(conn, opts.definition, opts.params),
        ),
        {
          onLeft: (cause) =>
            Effect.fail(
              new RemoteHookError({
                appId: opts.appId,
                method,
                connectionId: opts.connectionId,
                reason: `task-callback RPC failed: ${errorMessage(cause)}`,
                cause,
              }),
            ),
          onRight: (result) => Effect.succeed(result),
        },
      );
    });
  }

  /**
   * Apply the uniform timeout + fail-closed envelope to a raw hook
   * dispatch (in-process or remote). Three completion outcomes — totally
   * exhaustive over the wrapped Effect's behaviour:
   *
   *   - success → returns the verdict as-is.
   *   - `TimeoutException` (from `Effect.timeout`) → logs a warning via
   *     `Effect.logWarning`, returns the timeout verdict from `onTimeout`.
   *   - any other error (handler throw, RPC error, `NotConnectedError`,
   *     schema decode failure) → logs an error, returns the error
   *     verdict from `onError`.
   *
   * For `dispatch/authorize` `onTimeout` / `onError` synthesize a
   * fail-closed `deny` verdict. The error-channel narrowing to `never` is
   * the contract that lets call sites compose hooks via `Effect.forEach`
   * with no handler-error visibility.
   */
  private wrapHookEffectWithEnvelope<Verdict>(opts: {
    raw: Effect.Effect<Verdict, Error>;
    timeoutMs: number;
    timeoutLogMessage: string;
    timeoutLogContext: Record<string, unknown>;
    errorLogMessage: string;
    errorLogContext: Record<string, unknown>;
    onTimeout: () => Verdict;
    onError: () => Verdict;
  }): Effect.Effect<Verdict, never> {
    return opts.raw.pipe(
      Effect.timeout(`${opts.timeoutMs} millis`),
      Effect.catchTag("TimeoutException", () =>
        Effect.gen(function* () {
          yield* Effect.logWarning(opts.timeoutLogMessage).pipe(
            Effect.annotateLogs(opts.timeoutLogContext),
          );
          return opts.onTimeout();
        }),
      ),
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          yield* Effect.logError(opts.errorLogMessage).pipe(
            Effect.annotateLogs({
              ...opts.errorLogContext,
              err: errorMessage(err),
            }),
          );
          return opts.onError();
        }),
      ),
    );
  }
}
