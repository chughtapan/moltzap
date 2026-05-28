/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import type { Db } from "../db/client.js";
import type { ContactService } from "../identity/services/contact-policy.js";
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
import { DispatchAuthorize, TaskCreate } from "@moltzap/protocol";
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
} from "./types.js";
import { AppRegistry, type AppRegistration } from "./app-registration.js";
import { MessagesAuthorize } from "@moltzap/protocol";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect, Option } from "effect";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";
import {
  lookupAppForConversation,
  type ConversationAppLookup,
} from "./conversation-app-lookup.js";
import { NetworkSendServiceTag } from "./layers.js";
import type {
  LeaseRegistry,
  LeaseVerdict,
} from "../task/leases/lease-registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Structural slice of {@link ConversationService} that AppHost +
 * `installDefaultApp` depend on. Defined locally rather than
 * importing the concrete service to avoid a circular import — the
 * layer order has ConversationService depending on AppHost.
 *
 *  - `removeParticipant`: #529 reshape deny arm (forked moderator
 *    round-trip drops the recipient on deny).
 *  - `getParticipantAgentIds`: default-app `messages/authorize`
 *    forward-all policy reads the conversation's participant set
 *    here instead of re-implementing the SQL.
 */
export interface ConversationServiceForAppHost {
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
    requesterAgentId: AgentId,
  ): Effect.Effect<void, unknown, NetworkSendServiceTag>;
  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]>;
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

/**
 * Hook registry + fail-closed envelope for every "send context, get
 * verdict" S→C interaction. The same `Hook&lt;TContext, TResult>`
 * abstraction backs `dispatch/authorize` (lease verdict) and
 * `messages/authorize` (delivery verdict). Each hook runner uses the
 * three-step resolution and the envelope to keep the wire surface
 * uniform.
 *
 * ```mermaid
 * flowchart TD
 *   subgraph Registries
 *     RegA[appId-keyed hooks<br>AppHooks slot taskAuthorizeDispatch]
 *     RegB[EndpointAddress-keyed messageAuthorizeHooks<br>seeded for DEFAULT_DM_TM / DEFAULT_GROUP_TM]
 *     Remote[remoteRegistrations<br>appId → connectionId<br>set by registerRemoteApp on apps/register success]
 *   end
 *
 *   Call[hook runner — dispatchAuthorizeHook or runMessageAuthorize] --> Step1{lookup in-process registry by primary key}
 *   Step1 -- found --> InProc[runInProcessHookEffect]
 *   Step1 -- miss --> Step2{derive appId, lookup remoteRegistrations}
 *   Step2 -- found --> RemoteRun[runRemoteHookEffect — RPC via connectionId+definition+params]
 *   Step2 -- miss --> Default[synthetic default<br>messageAuthorize Forward — recipients participants minus sender<br>authorizeDispatch grant]
 *   InProc --> Envelope[wrapHookEffectWithEnvelope<br>raw, timeoutMs, onTimeout, onError, log contexts]
 *   RemoteRun --> Envelope
 *   Default --> Envelope
 *   Envelope --> FailClosed[timeout, handler throw, RPC failure, decode failure<br>collapse to onTimeout / onError<br>e.g. messageAuthorize Block reason tm_unreachable]
 * ```
 *
 * Every fail-mode collapses to a deny-shaped verdict so callers
 * never see an Effect failure on the hook channel — the envelope IS
 * the contract.
 */
export class AppHost {
  /**
   * Single source of truth for app registrations. Each `AppId` maps to
   * one `AppRegistration` carrying its `MoltZapConnection` — a real WS
   * connection for wire-registered apps, a loopback connection for
   * boot-installed apps (e.g. `DEFAULT_APP_ID`). AppHost dispatches
   * via the connection uniformly; see `./app-registration.ts`.
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
  private conversationService: ConversationServiceForAppHost | null = null;

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
  setConversationService(svc: ConversationServiceForAppHost): void {
    this.conversationService = svc;
  }

  /** Test-only / handler-side accessor. */
  getLeaseRegistry(): LeaseRegistry | null {
    return this.leaseRegistry;
  }

  /**
   * Register an app under the given connection. The registry rejects
   * overwrites unconditionally — returns false when `manifest.appId`
   * is already registered. Callers (the `apps/register` handler and
   * `installDefaultApp`) decide how to surface false (typed
   * `ForbiddenError` over the wire; exception at boot).
   */
  registerApp(manifest: AppManifest, connection: MoltZapConnection): boolean {
    const ok = this.apps.register(manifest, connection);
    if (ok) {
      Effect.runFork(
        Effect.logInfo("App registered").pipe(
          Effect.annotateLogs({
            appId: manifest.appId,
            connectionId: connection.id,
          }),
        ),
      );
    }
    return ok;
  }

  /**
   * Drop a registration. Idempotent (no-op if absent). The
   * boot-installed default app is never unregistered in production —
   * its loopback connection has a stable id no client caller can
   * match, so {@link unregisterAppsForConnection} never targets it.
   */
  unregisterApp(appId: AppId): void {
    if (this.apps.unregister(appId)) {
      Effect.runFork(
        Effect.logInfo("App unregistered").pipe(Effect.annotateLogs({ appId })),
      );
    }
  }

  /**
   * Drop every registration whose connection matches `connId`. Called
   * by `socket-handler.ts → closeSession` on WS disconnect. The
   * default app's loopback connection has a server-minted id that no
   * client connection can ever match, so this method never targets
   * boot-installed apps.
   */
  unregisterAppsForConnection(connId: ConnectionId): void {
    this.apps.unregisterByConnection(connId);
  }

  /**
   * Read-side accessor for handlers + capability obtain helpers.
   * Returns the registration record (manifest + connection) or
   * undefined if no entry exists.
   */
  lookupApp(appId: AppId): AppRegistration | undefined {
    return this.apps.get(appId);
  }

  /**
   * TM-authority gate: returns true iff `callerConnId` IS the
   * connection currently registered for `appId`. For the default app
   * (loopback connection with a server-minted id), no client caller
   * can match — always returns false.
   */
  isAppConnection(appId: AppId, callerConnId: ConnectionId): boolean {
    const entry = this.apps.get(appId);
    return entry !== undefined && entry.connection.id === callerConnId;
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
      moderatorConnectionId: entry?.connection.id ?? EMPTY_CONNECTION_ID,
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
        // `DispatchAuthorizeContext` derives from the wire schema, whose
        // `pending` array is mutable; the round-trip params carry it as
        // `ReadonlyArray`. Copy into a fresh mutable array so the derived
        // type accepts it without widening the source.
        pending: params.pending === undefined ? undefined : [...params.pending],
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
   * Dispatch a `dispatch/authorize` hook. In-process / remote choice
   * is made INSIDE the helper; callers see one signature and one
   * return type. Returns `{ decision: "grant" }` when no hook is
   * registered. Fail-closed on timeout / handler error / RPC failure.
   *
   * ```mermaid
   * sequenceDiagram
   *   participant Caller as MessageService.send
   *   participant AH as dispatchAuthorizeHook
   *   participant Mod as Moderator client
   *   participant LR as LeaseRegistry
   *   participant Recv as Recipient client
   *
   *   Caller->>AH: ctx {taskId, callerAgentId, conversationId, parts, ...}
   *   alt in-process hook registered
   *     AH->>AH: runInProcessHookEffect
   *   else remote registration found
   *     Note over AH: remote = remoteRegistrations.get(appId)<br>conn = connections.get(remote.connectionId)
   *     AH->>Mod: conn.originator.call(DispatchAuthorize, params)
   *     Note over Mod: decodeServerInbound → ServerRequest<br>client TypedDispatcher.handle<br>taskCallbackHandlers["dispatch/authorize"]
   *     Mod-->>AH: response frame — verdict {grant|deny|hold}
   *   else neither
   *     AH-->>AH: synthetic grant
   *   end
   *   Note over AH: wrapHookEffectWithEnvelope<br>timeout → deny reason timeout<br>RPC error → deny reason "dispatch/authorize error"
   *   AH->>LR: leaseRegistry.resolve(leaseId, verdict)
   *   alt deny
   *     LR-->>AH: DENIED → conversationService.removeParticipant
   *   else grant
   *     LR-->>AH: GRANTED
   *   end
   *   AH->>Recv: emit dispatch/release {verdict}
   * ```
   *
   * Server→client request frames are restricted to
   * `taskCallbackMethods` by `decodeServerInbound`; a misconfigured
   * server cannot smuggle a non-callback method through the client's
   * inbound path. The originator lifecycle (`pending` map, id prefix,
   * finalizer ordering) is the same one used for client-originated
   * RPCs — see the typed dispatcher in `@moltzap/protocol`.
   *
   * `runMessageAuthorize` is the sibling caller of
   * `wrapHookEffectWithEnvelope`: keyed by `EndpointAddress` instead
   * of `appId`, with verdicts in `Forward`/`Block` shape instead of
   * grant/deny/hold.
   */
  private dispatchAuthorizeHook(
    appId: AppId,
    ctx: DispatchAuthorizeContext,
  ): Effect.Effect<DispatchAdmissionResult, never> {
    const entry = this.apps.get(appId);
    if (entry === undefined) {
      // Unknown app — fail-closed Deny. Every registered conversation's
      // appId came from `AppsRegister` or boot, so reaching here means
      // the app's WS dropped after the conversation was created. No
      // moderator means no admission grant.
      return Effect.succeed({
        decision: "deny" as const,
        reason: "app_unavailable",
      });
    }
    const timeoutMs =
      entry.manifest.hooks?.dispatch_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw: this.callAppRpc(
        entry,
        DispatchAuthorize,
        this.authorizeDispatchParamsForWire(ctx),
      ).pipe(Effect.map((envelope) => envelope.admission)),
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

  /**
   * Resolve the per-message fan-out verdict for a `messages/send`.
   * Dispatches `messages/authorize` over the app's connection (real
   * WS for wire apps, loopback for the boot-installed default), then
   * applies the uniform fail-closed envelope.
   *
   * Unknown-app: fail-closed Block. Reaching this branch means the
   * app's WS dropped after the conversation was created; without a
   * moderator there's nobody to authorize the fan-out.
   *
   * Fail-closed posture: timeout / RPC error / decode failure all
   * synthesize `Block { reason: "tm_unreachable" }`.
   */
  runMessageAuthorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const entry = this.apps.get(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "Block" as const,
        reason: "tm_unreachable",
      });
    }

    const timeoutMs =
      entry.manifest.hooks?.message_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    return this.wrapHookEffectWithEnvelope<MessageAuthorizeResult>({
      raw: this.callAppRpc(
        entry,
        MessagesAuthorize,
        this.messageAuthorizeParamsForWire(ctx),
      ).pipe(Effect.map((envelope) => envelope.verdict)),
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

  /**
   * Fire the `task/create` TM callback after `task/request` lands a
   * task in `waiting`. The TM's typed verdict drives the lifecycle
   * transition (`waiting → active` on accept, `waiting → failed`
   * on reject or any fail-closed synthesis: timeout, RPC error,
   * decode failure).
   *
   * Unknown app → fail-closed reject (synthesized `tm_unreachable`).
   * Same posture as {@link runMessageAuthorize}.
   */
  runTaskCreate(
    appId: AppId,
    ctx: ParamsOf<typeof TaskCreate>,
  ): Effect.Effect<ResultOf<typeof TaskCreate>["verdict"], never> {
    const entry = this.apps.get(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "reject" as const,
        reason: "tm_unreachable",
      });
    }
    const timeoutMs =
      entry.manifest.hooks?.task_create?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    return this.wrapHookEffectWithEnvelope<
      ResultOf<typeof TaskCreate>["verdict"]
    >({
      raw: this.callAppRpc(entry, TaskCreate, ctx).pipe(
        Effect.map((envelope) => envelope.verdict),
      ),
      timeoutMs,
      timeoutLogMessage: "task/create timed out",
      timeoutLogContext: { taskId: ctx.taskId, appId, timeoutMs },
      errorLogMessage: "task/create error",
      errorLogContext: { taskId: ctx.taskId, appId },
      onTimeout: () => ({
        decision: "reject" as const,
        reason: "timeout",
      }),
      onError: () => ({
        decision: "reject" as const,
        reason: "tm_unreachable",
      }),
    });
  }

  /**
   * Dispatch a task-callback RPC over the app's connection. The
   * connection knows whether it's a real WS or a loopback — AppHost
   * doesn't care. Errors (NotConnectedError, RPC response error,
   * socket error, decode failure) fold into the fail-closed envelope
   * upstream via `wrapHookEffectWithEnvelope`.
   */
  private callAppRpc<D extends AnyTaskCallbackRpcDefinition>(
    entry: AppRegistration,
    definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, Error> {
    return sendRpcToClient(entry.connection, definition, params).pipe(
      // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Upstream `wrapHookEffectWithEnvelope` collapses every Effect failure into a fail-closed verdict; per-tag handling cannot influence the outcome. The `RemoteHookError` here preserves call-context (appId, method, connectionId) in the log message and is the documented `messageAuthorizeRaw`/`dispatchAuthorizeRaw` envelope shape from #529.
      Effect.mapError(
        (cause) =>
          new RemoteHookError({
            appId: entry.appId,
            method: definition.name,
            connectionId: entry.connection.id,
            reason: `task-callback RPC failed: ${errorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  /**
   * Wire-shape params for `messages/authorize`. Mirrors
   * {@link authorizeDispatchParamsForWire}: conditionally include
   * optional fields so the TypeBox schema's `additionalProperties:
   * false` doesn't reject an explicit `undefined`.
   */
  private messageAuthorizeParamsForWire(
    ctx: MessageAuthorizeContext,
  ): ParamsOf<typeof MessagesAuthorize> {
    return {
      taskId: ctx.taskId,
      appId: ctx.appId,
      conversationId: ctx.conversationId,
      message: {
        id: ctx.message.id,
        senderAgentId: ctx.message.senderAgentId,
        ...(ctx.message.parts !== undefined
          ? { parts: ctx.message.parts }
          : {}),
      },
      ...(ctx.receivedAt !== undefined ? { receivedAt: ctx.receivedAt } : {}),
      ...(ctx.clock !== undefined ? { clock: ctx.clock } : {}),
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

  private authorizeDispatchParamsForWire(
    ctx: DispatchAuthorizeContext,
  ): ParamsOf<typeof DispatchAuthorize> {
    return {
      taskId: ctx.taskId,
      appId: ctx.appId,
      conversationId: ctx.conversationId,
      recipient: ctx.recipient,
      message: {
        id: ctx.message.id,
        senderAgentId: ctx.message.senderAgentId,
        ...(ctx.message.parts !== undefined
          ? { parts: ctx.message.parts }
          : {}),
      },
      attempt: ctx.attempt,
      ...(ctx.receivedAt !== undefined ? { receivedAt: ctx.receivedAt } : {}),
      ...(ctx.clock !== undefined ? { clock: ctx.clock } : {}),
      ...(ctx.pending !== undefined
        ? {
            pending: ctx.pending.map((pending) => ({
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
