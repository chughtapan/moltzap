/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import type { Db } from "../db/client.js";
import type { ContactService } from "../identity/services/contact-policy.js";
import { sendRpcToClient } from "../transport/connection.js";
import type { ConnectionManager } from "../transport/connection.js";
import type {
  AppManifest,
  DispatchId,
  LeaseId,
  ParamsOf,
  Part,
  ReverseCallbackRequest,
  ReverseCallbackSuccess,
  ResultOf,
} from "@moltzap/protocol";
import {
  DispatchAuthorize,
  TaskCreate,
  type ConnectionId,
} from "@moltzap/protocol";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { AppId, ConversationId, MessageId } from "@moltzap/protocol/task";
import {
  type DispatchAdmissionResult,
  type MessageAuthorizeContext,
  type MessageAuthorizeResult,
  type DispatchAuthorizeContext,
} from "./types.js";
import {
  AppRegistry,
  type AppEndpoint,
  type AppRegistration,
} from "./app-registration.js";
import { MessagesAuthorize } from "@moltzap/protocol";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect, Option } from "effect";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";
import {
  lookupAppBoundForConversation,
  type AppBoundConversationLookup,
} from "./conversation-app-lookup.js";
import { NetworkSendServiceTag } from "./layers.js";
import type {
  LeaseRegistry,
  LeaseVerdict,
  ModeratorBoundLeaseBinding,
} from "../task/leases/lease-registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Structural slice of `ConversationService` that AppHost +
 * `installDefaultApp` depend on. Defined locally rather than
 * importing the concrete service to avoid a circular import — the
 * layer order has ConversationService depending on AppHost.
 *
 *  - `removeParticipant`: the deny arm (forked moderator round-trip drops the
 *    recipient on deny).
 *  - `getParticipantAgentIds`: default-app `messages/authorize`
 *    forward-all policy reads the conversation's participant set
 *    here instead of re-implementing the SQL.
 */
export interface ConversationServiceForAppHost {
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
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

class DispatchAppUnavailableError extends Data.TaggedError(
  "DispatchAppUnavailableError",
)<{
  readonly appId: AppId;
  readonly conversationId: ConversationId;
}> {
  override get message(): string {
    return `dispatch/request cannot mint a moderator-bound lease because app ${this.appId} is unavailable for conversation ${this.conversationId}`;
  }
}

type PendingDispatchMessage = Readonly<{
  messageId: MessageId;
  conversationId: ConversationId;
  senderAgentId: AgentId;
  createdAt: string;
  receivedAt: string;
  // Wire `pending[].parts` decodes to `readonly Part[]`.
  parts?: ReadonlyArray<Part>;
}>;

interface EnqueueDispatchRequestArgs {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  // Wire params decode to deeply-`readonly` Effect Schema types; these inputs
  // are never mutated here, so accept `ReadonlyArray`.
  readonly parts?: ReadonlyArray<Part>;
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly pending?: ReadonlyArray<PendingDispatchMessage>;
}

interface DispatchRoundTripParams {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: ReadonlyArray<Part>;
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly pending?: ReadonlyArray<PendingDispatchMessage>;
}

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
 * verdict" S→C interaction. A single {@link AppRegistry} keyed by
 * `AppId` carries each app's `AppEndpoint`; the same envelope backs
 * `dispatch/authorize` (lease verdict), `messages/authorize` (delivery
 * verdict), and `task/create` (task gate). Each hook runner uses the
 * two-arm resolution below and the envelope to keep the wire surface
 * uniform.
 *
 * ```mermaid
 * flowchart TD
 *   Call[hook runner — dispatchAuthorizeHook / runMessageAuthorize / runTaskCreate] --> Lookup{apps.get appId}
 *   Lookup -- undefined --> FailClosed0[fail-closed synthetic verdict<br>deny app_unavailable / Block app_unreachable / reject app_unreachable]
 *   Lookup -- found --> Policy{switch manifest hook policy.kind}
 *   Policy -- grant / deny / forwardAllExceptSender / accept / reject --> Static[static verdict resolved in-process<br>zero wire round-trip]
 *   Policy -- hook --> Rpc[callAppRpc entry.endpoint.originator, definition, params]
 *   Rpc --> Envelope[wrapHookEffectWithEnvelope<br>raw, timeoutMs, onTimeout, onError, log contexts]
 *   Envelope --> FailClosed[timeout, handler throw, RPC failure, decode failure<br>collapse to onTimeout / onError<br>e.g. messageAuthorize Block reason app_unreachable]
 * ```
 *
 * Every fail-mode collapses to a deny-shaped verdict so callers never
 * see an Effect failure on the hook channel — the envelope IS the
 * contract. The static-policy arms and the fail-closed unknown-app arm
 * are pure (no app round-trip); only the `kind: "hook"` arm touches the
 * wire, and it is the only arm under the timeout envelope.
 */
export class AppHost {
  /**
   * Single source of truth for app registrations. Each `AppId` maps to
   * one `AppRegistration` carrying its `AppEndpoint` (`{ connId, originator }`)
   * — minted from the live `AppConnection` arm for connected apps, or an
   * inert endpoint for the boot-installed default app (`DEFAULT_APP_ID`).
   * AppHost dispatches via the endpoint's `originator` only for a policy whose
   * `kind` is `"hook"`; an app whose policies are all static (the default app)
   * never has its originator invoked. See `./app-registration.ts`.
   */
  private apps = new AppRegistry();

  private contactService: ContactService | null = null;

  /**
   * Optional lease registry for the dispatch-admission surface.
   * Set post-construction by the layer wiring (see {@link setLeaseRegistry}).
   * Consumed exclusively by `enqueueDispatchRequest`. Kept optional so
   * existing tests that construct AppHost directly without a registry
   * still work.
   */
  private leaseRegistry: LeaseRegistry | null = null;

  /**
   * Optional conversation service for the deny arm. Wired post-construction by
   * the server layer (see {@link setConversationService}). Used by the forked
   * moderator round-trip to call `removeParticipant` on verdict-deny /
   * synthesized timeout-deny — on a `deny` verdict the registry calls
   * `conversationService.removeParticipant(...)`.
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
   * Register an app under the given endpoint. The registry rejects
   * overwrites unconditionally — returns false when `appId` is already
   * registered. `appId` is the SERVER-MINTED identity (the authenticated
   * `AppConnection.auth.appId` on the implicit-registration path, or
   * `DEFAULT_APP_ID` at boot), NOT `manifest.appId`. Callers
   * (the appKey-Connect path and `installDefaultApp`) decide how to surface
   * false (typed `UnauthorizedError` over the wire; exception at boot).
   */
  registerApp(
    appId: AppId,
    manifest: AppManifest,
    endpoint: AppEndpoint,
  ): boolean {
    const ok = this.apps.register(appId, manifest, endpoint);
    if (ok) {
      Effect.runFork(
        Effect.logInfo("App registered").pipe(
          Effect.annotateLogs({
            appId,
            connectionId: endpoint.connId,
          }),
        ),
      );
    }
    return ok;
  }

  /**
   * Drop a registration. Idempotent (no-op if absent). The
   * boot-installed default app is never unregistered in production —
   * its inert endpoint has a stable server-minted id no client caller
   * can match, so {@link unregisterAppsForConnection} never targets it.
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
   * by `MoltZapServer`/`transport/server-socket.ts` close cleanup on WS disconnect. The
   * default app's inert endpoint has a server-minted id that no
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

  setContactService(checker: ContactService): void {
    this.contactService = checker;
  }

  /**
   * Read-side accessor used by peer services (notably
   * `ConversationService`) that must consult the same contact policy
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
   *  - non-`AppBound` lookup results are invariant violations for this
   *    surface; no lease is minted.
   *  - `AppBound` whose app has no live registration before mint:
   *    fail before the registry is reachable.
   *  - `AppBound` whose app disconnects after mint: synthesize
   *    `deny{app_unavailable}`.
   *  - `AppBound` with a live registration: run the
   *    `dispatch_authorize` policy switch; a verdict-deny + timeout-deny
   *    call `resolve(deny)` and the caller is responsible for
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
      const lookup = yield* lookupAppBoundForConversation(
        this.db,
        args.conversationId,
      );
      const binding = yield* this.dispatchLeaseBindingForLookup(args, lookup);
      const minted = yield* registry.mint(binding);

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
          pending: args.pending,
        },
      );
      return minted;
    });
  }

  private dispatchLeaseBindingForLookup(
    args: EnqueueDispatchRequestArgs,
    lookup: AppBoundConversationLookup,
  ): Effect.Effect<ModeratorBoundLeaseBinding, never> {
    const base = {
      recipientAgentId: args.recipientAgentId,
      recipientConnectionId: args.recipientConnectionId,
      conversationId: args.conversationId,
    };

    const entry = this.apps.get(lookup.appId);
    if (!entry) {
      return Effect.die(
        new DispatchAppUnavailableError({
          appId: lookup.appId,
          conversationId: args.conversationId,
        }),
      );
    }

    return Effect.succeed({
      _tag: "ModeratorBound",
      ...base,
      appId: lookup.appId,
      taskId: lookup.taskId,
      moderatorConnectionId: entry.endpoint.connId,
    });
  }

  private attachDispatchRoundTripFiber(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: AppBoundConversationLookup,
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
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    return catchSqlErrorAsDefect(
      this.runAppBoundDispatchRoundTrip(registry, leaseId, lookup, params),
    );
  }

  private runAppBoundDispatchRoundTrip(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, SqlError, NetworkSendServiceTag> {
    if (!this.isAppRegistered(lookup.appId)) {
      return this.resolveDispatchLease(registry, leaseId, {
        _tag: "deny",
        reason: "app_unavailable",
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

  private isAppRegistered(appId: AppId): boolean {
    return this.apps.has(appId);
  }

  private dispatchAuthorizeContext(
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<DispatchAuthorizeContext, SqlError> {
    return Effect.gen(this, function* () {
      const ownerUserId = yield* this.recipientOwnerId(params.recipientAgentId);
      return {
        conversationId: params.conversationId,
        recipient: { agentId: params.recipientAgentId, ownerUserId },
        message: {
          id: params.messageId,
          senderAgentId: params.senderAgentId,
          parts: params.parts,
        },
        taskId: lookup.taskId,
        appId: lookup.appId,
        attempt: params.attempt ?? 0,
        receivedAt: params.receivedAt,
        // `DispatchAuthorizeContext` derives from the wire schema, whose
        // `pending` array is mutable; the round-trip params carry it as
        // `ReadonlyArray`. Copy into a fresh mutable array so the derived
        // type accepts it without widening the source.
        pending: params.pending === undefined ? undefined : [...params.pending],
      };
    });
  }

  private recipientOwnerId(agentId: AgentId): Effect.Effect<UserId, SqlError> {
    return takeFirstOption(
      this.db
        .selectFrom("agents")
        .select("owner_user_id")
        .where("id", "=", agentId),
    ).pipe(
      Effect.flatMap((agentOpt) =>
        Option.match(agentOpt, {
          onNone: () =>
            Effect.dieMessage(`recipient agent ${agentId} not found`),
          onSome: (agent) => Effect.succeed(agent.owner_user_id),
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
    if (svc === null) return Effect.void;
    // The moderator is an `AppConnection` (no `agentId`), so deny-removal does
    // not resolve an actor agentId from the moderator connection:
    // `conversationService.removeParticipant` does not consume one. The eviction
    // targets the recipient; provenance is structurally the task's bound app.
    return svc
      .removeParticipant(params.conversationId, params.recipientAgentId)
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

  /**
   * Resolve the receive-side admission verdict. Switches on the
   * manifest's `dispatch_authorize` policy: `grant` / `deny` resolve
   * in-process with zero wire round-trip, `hook` round-trips to the
   * bound moderator under the fail-closed envelope. Fail-closed on
   * unknown app / timeout / handler error / RPC failure.
   *
   * ```mermaid
   * sequenceDiagram
   *   participant Caller as MessageService.send
   *   participant AH as dispatchAuthorizeHook
   *   participant App as Bound app client
   *   participant LR as LeaseRegistry
   *   participant Recv as Recipient client
   *
   *   Caller->>AH: ctx {taskId, appId, conversationId, parts, ...}
   *   alt apps.get(appId) undefined
   *     AH-->>AH: synthetic deny reason app_unavailable
   *   else policy.kind grant
   *     AH-->>AH: grant resolved in-process
   *   else policy.kind deny
   *     AH-->>AH: deny reason policy.reason resolved in-process
   *   else policy.kind hook
   *     AH->>App: callAppRpc(entry.endpoint.originator, DispatchAuthorize, params)
   *     Note over App: reverse RpcServer decodes the callback descriptor<br>taskCallbackHandlers["dispatch/authorize"]
   *     App-->>AH: response frame — verdict {grant|deny|hold}
   *     Note over AH: wrapHookEffectWithEnvelope<br>timeout → deny reason timeout<br>RPC error → deny reason "dispatch/authorize error"
   *   end
   *   AH->>LR: leaseRegistry.resolve(leaseId, verdict)
   *   alt deny
   *     LR-->>AH: DENIED → conversationService.removeParticipant
   *   else grant
   *     LR-->>AH: GRANTED
   *   end
   *   AH->>Recv: emit dispatch/release {verdict}
   * ```
   *
   * Server→client request frames are restricted to `appCallbackMethods` by
   * the client's reverse `RpcServer` group; a misconfigured server cannot
   * smuggle a non-callback method through the client's inbound path. The
   * originator lifecycle (`pending` map, id prefix,
   * finalizer ordering) is the same one used for client-originated
   * RPCs — see the typed dispatcher in `@moltzap/protocol`.
   *
   * `runMessageAuthorize` is the sibling caller of
   * `wrapHookEffectWithEnvelope`: also keyed by `appId`, with verdicts
   * in `Forward`/`Block` shape instead of grant/deny/hold.
   */
  private dispatchAuthorizeHook(
    appId: AppId,
    ctx: DispatchAuthorizeContext,
  ): Effect.Effect<DispatchAdmissionResult, never> {
    const entry = this.apps.get(appId);
    if (entry === undefined) {
      // Unknown app — fail-closed Deny. Every registered conversation's
      // appId came from HTTP registration/connect or boot, so reaching here means
      // the app's WS dropped after the conversation was created. No
      // moderator means no admission grant.
      return Effect.succeed({
        decision: "deny" as const,
        reason: "app_unavailable",
      });
    }
    const policy = entry.manifest.hooks.dispatch_authorize;
    switch (policy.kind) {
      case "grant":
        return Effect.succeed({ decision: "grant" as const });
      case "deny":
        return Effect.succeed({
          decision: "deny" as const,
          reason: policy.reason,
        });
      case "hook": {
        const taskId = ctx.taskId;
        const timeoutMs = policy.timeoutMs;
        return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
          raw: this.callAppRpc(entry, {
            definition: DispatchAuthorize,
            params: this.authorizeDispatchParamsForWire(ctx),
          }).pipe(Effect.map((envelope) => envelope.admission)),
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
    }
    const _exhaustive: never = policy;
    return _exhaustive;
  }

  /**
   * Compute the `forwardAllExceptSender` policy verdict in-process:
   * `Forward { participants ∖ sender }`, reading the conversation's
   * participant set via the ConversationService back-edge. Fails closed
   * (`Block { reason: "app_unreachable" }`) when no ConversationService
   * is wired (unit-test layer), mirroring the unknown-app posture in
   * {@link runMessageAuthorize}.
   */
  private forwardAllExceptSender(
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const svc = this.conversationService;
    if (svc === null) {
      return Effect.succeed({
        decision: "Block" as const,
        reason: "app_unreachable",
      });
    }
    return svc.getParticipantAgentIds(ctx.conversationId).pipe(
      Effect.map((participants) => ({
        decision: "Forward" as const,
        recipients: participants.filter(
          (id) => id !== ctx.message.senderAgentId,
        ),
      })),
      Effect.withSpan("appHost.messageAuthorize.forwardAllExceptSender"),
    );
  }

  /**
   * Resolve the per-message fan-out verdict for a `messages/send`.
   * Switches on the manifest's `message_authorize` policy:
   * `forwardAllExceptSender` / `deny` resolve in-process,
   * `hook` round-trips `messages/authorize` over the app's connection
   * (the connected app's WebSocket) under the uniform fail-closed
   * envelope.
   *
   * Unknown-app: fail-closed Block. Reaching this branch means the
   * app's WS dropped after the conversation was created; without a
   * moderator there's nobody to authorize the fan-out.
   *
   * Fail-closed posture: timeout / RPC error / decode failure all
   * synthesize `Block { reason: "app_unreachable" }`.
   */
  runMessageAuthorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const entry = this.apps.get(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "Block" as const,
        reason: "app_unreachable",
      });
    }

    const policy = entry.manifest.hooks.message_authorize;
    switch (policy.kind) {
      case "forwardAllExceptSender":
        return this.forwardAllExceptSender(ctx);
      case "deny":
        return Effect.succeed({
          decision: "Block" as const,
          reason: policy.reason,
        });
      case "hook":
        return this.messageAuthorizeHook(entry, appId, ctx, policy.timeoutMs);
    }
    const _exhaustive: never = policy;
    return _exhaustive;
  }

  /** Round-trip `messages/authorize` to the bound TM under the envelope. */
  private messageAuthorizeHook(
    entry: AppRegistration,
    appId: AppId,
    ctx: MessageAuthorizeContext,
    timeoutMs: number,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const taskId = ctx.taskId;
    return this.wrapHookEffectWithEnvelope<MessageAuthorizeResult>({
      raw: this.callAppRpc(entry, {
        definition: MessagesAuthorize,
        params: this.messageAuthorizeParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.verdict)),
      timeoutMs,
      timeoutLogMessage: "messages/authorize timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "messages/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => ({
        decision: "Block" as const,
        reason: "app_unreachable",
      }),
      onError: () => ({
        decision: "Block" as const,
        reason: "app_unreachable",
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
   * Unknown app → fail-closed reject (synthesized `app_unreachable`).
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
        reason: "app_unreachable",
      });
    }
    const policy = entry.manifest.hooks.task_create;
    switch (policy.kind) {
      case "accept":
        return Effect.succeed({ decision: "accept" as const });
      case "reject":
        return Effect.succeed({
          decision: "reject" as const,
          reason: policy.reason,
        });
      case "hook": {
        const timeoutMs = policy.timeoutMs;
        return this.wrapHookEffectWithEnvelope<
          ResultOf<typeof TaskCreate>["verdict"]
        >({
          raw: this.callAppRpc(entry, {
            definition: TaskCreate,
            params: ctx,
          }).pipe(Effect.map((envelope) => envelope.verdict)),
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
            reason: "app_unreachable",
          }),
        });
      }
    }
    const _exhaustive: never = policy;
    return _exhaustive;
  }

  /**
   * Dispatch a task-callback RPC over the app's connection. Reached
   * only from a `kind: "hook"` policy arm — an app whose policies are
   * all static (the default app) resolves every verdict in-process and
   * never calls here. Errors (NotConnectedError, RPC response error,
   * socket error, decode failure) fold into the fail-closed envelope
   * upstream via `wrapHookEffectWithEnvelope`.
   */
  private callAppRpc(
    entry: AppRegistration,
    request: Extract<
      ReverseCallbackRequest,
      { readonly definition: typeof DispatchAuthorize }
    >,
  ): Effect.Effect<ReverseCallbackSuccess<typeof DispatchAuthorize>, Error>;
  private callAppRpc(
    entry: AppRegistration,
    request: Extract<
      ReverseCallbackRequest,
      { readonly definition: typeof MessagesAuthorize }
    >,
  ): Effect.Effect<ReverseCallbackSuccess<typeof MessagesAuthorize>, Error>;
  private callAppRpc(
    entry: AppRegistration,
    request: Extract<
      ReverseCallbackRequest,
      { readonly definition: typeof TaskCreate }
    >,
  ): Effect.Effect<ReverseCallbackSuccess<typeof TaskCreate>, Error>;
  private callAppRpc(
    entry: AppRegistration,
    request: ReverseCallbackRequest,
  ): Effect.Effect<
    ReverseCallbackSuccess<ReverseCallbackRequest["definition"]>,
    Error
  > {
    return sendRpcToClient(entry.endpoint.originator, request).pipe(
      // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Upstream `wrapHookEffectWithEnvelope` collapses every Effect failure into a fail-closed verdict; per-tag handling cannot influence the outcome. The `RemoteHookError` here preserves call-context (appId, method, connectionId) in the log message and is the `messageAuthorizeRaw`/`dispatchAuthorizeRaw` envelope shape.
      Effect.mapError(
        (cause) =>
          new RemoteHookError({
            appId: entry.appId,
            method: request.definition.name,
            connectionId: entry.endpoint.connId,
            reason: `task-callback RPC failed: ${errorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  /**
   * Wire-shape params for `messages/authorize`. Mirrors
   * {@link authorizeDispatchParamsForWire}: conditionally include
   * optional fields so the wire schema's `onExcessProperty: "error"`
   * strict decode doesn't reject an explicit `undefined`.
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
  // Every hook returns `Effect<Verdict, never>` regardless of source. The
  // branching between in-process and remote is INSIDE the dispatch helpers;
  // call sites observe one type. Failure
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
      ...(ctx.pending !== undefined
        ? {
            pending: ctx.pending.map((pending) => ({
              messageId: pending.messageId,
              conversationId: pending.conversationId,
              senderAgentId: pending.senderAgentId,
              createdAt: pending.createdAt,
              receivedAt: pending.receivedAt,
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
