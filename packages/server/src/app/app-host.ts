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
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import {
  type DispatchAdmissionResult,
  type MessageAuthorizeContext,
  type MessageAuthorizeHook,
  type MessageAuthorizeResult,
  type TaskAuthorizeDispatchContext,
  type TaskAuthorizeDispatchHook,
} from "./hooks.js";
import { MessagesAuthorize } from "@moltzap/protocol";
import {
  endpointAddressKind,
  type EndpointAddress,
} from "@moltzap/protocol/network";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect, Either, Option } from "effect";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";
import {
  lookupAppForConversation,
  type ConversationAppLookup,
} from "./conversation-app-lookup.js";
import type {
  LeaseRegistry,
  LeaseVerdict,
} from "../task/leases/lease-registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * For app-bound conversations whose TM IS the moderator agent (the
 * common case per architect plan §3 + prereq 2 §3 — the
 * `assertConversationAdminAuthority` gate accepts only this shape for
 * `app_id IS NOT NULL`), `tasks.tm_endpoint_address` is the wire
 * address `tm:agent:&lt;moderatorAgentId>`. Recover the agentId so the
 * deny arm of the forked round-trip can call `removeParticipant`
 * with the correct requester (epic decision #8).
 *
 * Returns `null` if the address shape doesn't match the expected
 * agent-kind prefix — caller falls back to no-op (the architect-level
 * authority chain is the source of truth; if the shape is unexpected,
 * we'd rather skip removeParticipant than mis-evict the recipient).
 */
function parseModeratorAgentIdFromTm(raw: string): AgentId | null {
  // Wire shape: "tm:agent:<uuid>". App-kind addresses ("tm:app:<uuid>")
  // are not moderator-IS-agent and shouldn't drive removeParticipant
  // — those are TM-as-app routing and the authority chain on
  // conversations.task.app_id != null requires moderator IS agent.
  const prefix = "tm:agent:";
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  if (rest.length === 0) return null;
  return rest as AgentId;
}

const DEFAULT_APP_HOOK_TIMEOUT_MS = 5000;
const EMPTY_TASK_ID = "" as TaskId;

/**
 * Derive an `appId` from an `EndpointAddress` for `remoteRegistrations`
 * lookup (#560 C5 remote-path resolution). The mapping is well-defined
 * only for the `tm:app:&lt;appId>` shape — custom-TM `tm:agent:&lt;id>`
 * addresses do not carry an appId and short-circuit to null. Caller
 * (`runMessageAuthorize`) falls through to the synthetic default
 * verdict when both the in-process hook AND this lookup are absent.
 */
function appIdFromTmEndpointAddress(address: EndpointAddress): string | null {
  if (endpointAddressKind(address) !== "app") return null;
  const prefix = "tm:app:";
  const raw = address as string;
  if (!raw.startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length);
  return rest.length === 0 ? null : rest;
}

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
  ): Effect.Effect<void, unknown>;
}

class RemoteHookError extends Data.TaggedError("RemoteHookError")<{
  readonly appId: string;
  readonly method: string;
  readonly connectionId: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

interface RemoteRegistration {
  readonly connectionId: string;
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
  readonly recipientConnectionId: string;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: Part[];
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly clock?: LogicalClock;
  readonly pending?: ReadonlyArray<PendingDispatchMessage>;
}

interface DispatchBindingContext {
  readonly appId: string;
  readonly taskId: TaskId;
  readonly tmEndpointAddress: string;
  readonly moderatorConnectionId: string;
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
  readonly tmEndpointAddress: string;
}

type AppBoundConversationLookup = Extract<
  ConversationAppLookup,
  { readonly _tag: "AppBound" }
>;

type NonAppBoundConversationLookup = Exclude<
  ConversationAppLookup,
  AppBoundConversationLookup
>;

interface MessageAuthorizeRoute {
  readonly inProcess: MessageAuthorizeHook | undefined;
  readonly remoteAppId: string | null;
  readonly remote: RemoteRegistration | undefined;
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

export class AppHost {
  private manifests = new Map<string, AppManifest>();
  private contactService: ContactService | null = null;
  private hooks = new Map<string, TaskAuthorizeDispatchHook>();

  /**
   * #560: send-side fan-out hooks keyed by `EndpointAddress`. The
   * lookup key for `messages/authorize` is the parent task's
   * `tm_endpoint_address` (always populated post-#461 R12), NOT an
   * appId. Default-DM and default-group register at boot under
   * `DEFAULT_DM_TM_ADDRESS` / `DEFAULT_GROUP_TM_ADDRESS`; app TMs
   * register under their `tm:app:&lt;uuid>` address; future custom TMs
   * (e.g., `tm:agent:&lt;id>`) register under that.
   *
   * No sentinel constants needed — the existing address shapes IS
   * the key. See R8 (ghost-service hazard) for why this stays
   * separate from the `AppTmRegistry` opaque-payload registry.
   */
  private messageAuthorizeHooks = new Map<
    EndpointAddress,
    MessageAuthorizeHook
  >();

  /**
   * Remote-app routing table. An entry exists iff `registerRemoteApp` was
   * called for `appId`; the value records which WS connection serves the
   * app's hook RPCs. Looked up at dispatch time (not registration time)
   * so the connection can be closed and re-resolved without re-registering
   * the app — the Scope finalizer on the old connection drains its
   * pending Deferreds with `NotConnectedError`, which the dispatch envelope
   * maps to fail-closed verdicts.
   *
   * Disjoint with `hooks` per-app: a given `appId` is either in-process
   * (entries in `hooks`) or remote (entry here), never both. The dispatch
   * helpers prefer the remote entry when present — `registerRemoteApp`
   * is the explicit promotion path.
   */
  private remoteRegistrations = new Map<string, RemoteRegistration>();

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
   * verdict, registry calls `conversationService.removeParticipant(...)`"
   * (epic decision #8). Synthesized infra-hold (no hook registered)
   * does NOT call removeParticipant — that is the prereq-2 hold case
   * (architect risk #5; epic decision #10).
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

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    Effect.runFork(
      Effect.logInfo("App registered").pipe(
        Effect.annotateLogs({ appId: manifest.appId }),
      ),
    );
  }

  /**
   * Register an app whose `dispatch/authorize` admission round-trips run
   * in a remote process (typically a WebSocket client). The verb
   * dispatches via {@link sendRpcToClient}; verdicts decode through the
   * schemas in `hooks.ts` and feed the same fail-closed envelope as
   * in-process hooks.
   *
   * Remote registration takes precedence over any prior in-process
   * registration for the same `appId`. Disconnect: every pending
   * Deferred fails with `NotConnectedError` via the connection's Scope
   * finalizer; the registration keeps pointing at the dead id and
   * dispatches stay fail-closed until the app re-registers.
   */
  registerRemoteApp(manifest: AppManifest, connectionId: string): void {
    this.manifests.set(manifest.appId, manifest);
    this.remoteRegistrations.set(manifest.appId, { connectionId });
    Effect.runFork(
      Effect.logInfo("Remote app registered").pipe(
        Effect.annotateLogs({ appId: manifest.appId, connectionId }),
      ),
    );
  }

  /**
   * Drop a remote-app registration. Idempotent — no-op if `appId` was not
   * previously registered as remote. Does NOT remove the manifest entry
   * (sessions and conversations may still reference it); callers that
   * want a full removal should also clear the manifest separately.
   *
   * Existing in-flight admission Deferreds are unaffected by this call —
   * they're owned by the connection's pending map and resolved either by
   * the response router (if the app replies) or by the Scope finalizer
   * on disconnect. Future dispatches for `appId` fall through to whatever
   * in-process hook is registered (or grant-by-default if none).
   */
  unregisterRemoteApp(appId: string): void {
    if (this.remoteRegistrations.delete(appId)) {
      Effect.runFork(
        Effect.logInfo("Remote app unregistered").pipe(
          Effect.annotateLogs({ appId }),
        ),
      );
    }
  }

  getManifest(appId: string): AppManifest | undefined {
    return this.manifests.get(appId);
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

  onTaskAuthorizeDispatch(
    appId: string,
    handler: TaskAuthorizeDispatchHook,
  ): void {
    this.hooks.set(appId, handler);
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
   *    (load-bearing — does NOT call `removeParticipant` per risk #5).
   *  - `AppBound` with hook: forked round-trip; verdict-deny + timeout-
   *    deny call `resolve(deny)` and the caller is responsible for
   *    `removeParticipant` via the standard verdict-deny path. (Hook
   *    surface here only manages the lease; participant removal stays in
   *    the existing legacy flow until cutover.)
   *
   * Returns immediately with `{leaseId, dispatchId}` (or fails closed
   * via `LeaseRegistry not wired` defect if the registry hasn't been
   * configured — caller should always wire it via {@link setLeaseRegistry}).
   */
  enqueueDispatchRequest(
    args: EnqueueDispatchRequestArgs,
  ): Effect.Effect<{ leaseId: LeaseId; dispatchId: DispatchId }, never, never> {
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
  ): Effect.Effect<{ leaseId: LeaseId; dispatchId: DispatchId }, SqlError> {
    return Effect.gen(this, function* () {
      const lookup = yield* lookupAppForConversation(
        this.db,
        args.conversationId,
      );
      const binding = yield* this.dispatchBindingForLookup(lookup);
      const minted = yield* registry.mint({
        recipientAgentId: args.recipientAgentId,
        recipientConnectionId: args.recipientConnectionId,
        moderatorConnectionId: binding.moderatorConnectionId,
        taskId: binding.taskId,
        conversationId: args.conversationId,
        tmEndpointAddress: binding.tmEndpointAddress,
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
          tmEndpointAddress: binding.tmEndpointAddress,
        },
      );
      return minted;
    });
  }

  private dispatchBindingForLookup(
    lookup: ConversationAppLookup,
  ): Effect.Effect<DispatchBindingContext, SqlError> {
    if (lookup._tag !== "AppBound") {
      return Effect.succeed({
        appId: "",
        taskId: EMPTY_TASK_ID,
        tmEndpointAddress: "",
        moderatorConnectionId: "",
      });
    }

    return Effect.gen(this, function* () {
      const tmEndpointAddress = yield* this.taskTmEndpointAddress(
        lookup.taskId,
      );
      const remote = this.remoteRegistrations.get(lookup.appId);
      return {
        appId: lookup.appId,
        taskId: lookup.taskId,
        tmEndpointAddress,
        moderatorConnectionId: remote?.connectionId ?? "",
      };
    });
  }

  private taskTmEndpointAddress(
    taskId: TaskId,
  ): Effect.Effect<string, SqlError> {
    return takeFirstOption(
      this.db
        .selectFrom("tasks")
        .select(["tm_endpoint_address"])
        .where("id", "=", taskId),
    ).pipe(
      Effect.map((taskRow) =>
        Option.match(taskRow, {
          onNone: () => "",
          onSome: (row) => row.tm_endpoint_address,
        }),
      ),
    );
  }

  private attachDispatchRoundTripFiber(
    registry: LeaseRegistry,
    leaseId: LeaseId,
    lookup: ConversationAppLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never> {
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
  ): Effect.Effect<void, never, never> {
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
  ): Effect.Effect<void, SqlError> {
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

  private hasDispatchAuthorizeHook(appId: string): boolean {
    return (
      this.remoteRegistrations.has(appId) || this.hooks.get(appId) !== undefined
    );
  }

  private dispatchAuthorizeContext(
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<TaskAuthorizeDispatchContext, SqlError> {
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
        pending: params.pending ? [...params.pending] : undefined,
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

  private removeDeniedParticipant(
    verdict: DispatchAdmissionResult,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never> {
    if (verdict.decision !== "deny") return Effect.void;
    const svc = this.conversationService;
    const moderatorAgentId = parseModeratorAgentIdFromTm(
      params.tmEndpointAddress,
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

  /**
   * Dispatch a `dispatch/authorize` hook. In-process / remote choice is
   * made INSIDE the helper; callers see one signature and one return
   * type. Returns `{ decision: "grant" }` when no hook is registered.
   * Fail-closed on timeout / handler error / RPC failure per architect
   * plan §3.4.
   */
  private dispatchAuthorizeHook(
    appId: string,
    ctx: TaskAuthorizeDispatchContext,
  ): Effect.Effect<DispatchAdmissionResult, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId);
    if (!remote && !inProcess) {
      return Effect.succeed({ decision: "grant" as const });
    }
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.dispatch_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw: this.dispatchAuthorizeRaw(appId, ctx, remote, inProcess),
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
    appId: string,
    ctx: TaskAuthorizeDispatchContext,
    remote: RemoteRegistration | undefined,
    inProcess: TaskAuthorizeDispatchHook | undefined,
  ): Effect.Effect<DispatchAdmissionResult, Error> {
    if (remote) {
      return this.runRemoteHookEffect({
        appId,
        definition: DispatchAuthorize,
        connectionId: remote.connectionId,
        params: this.authorizeDispatchParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.admission));
    }
    return this.runInProcessHookEffect<
      TaskAuthorizeDispatchContext,
      DispatchAdmissionResult
    >((ctxWithSignal) => inProcess!(ctxWithSignal), ctx);
  }

  /**
   * Register an in-process `messageAuthorize` handler keyed by
   * `EndpointAddress`. Issue #560 default-DM and default-group register at boot
   * (in `app-tm-registry.ts` or wherever default TMs bootstrap);
   * apps that hold their own `tm:app:&lt;uuid>` address register at
   * `apps/register` time. Idempotent — repeat calls overwrite the
   * existing entry for that address.
   */
  registerMessageAuthorize(
    address: EndpointAddress,
    hook: MessageAuthorizeHook,
  ): void {
    this.messageAuthorizeHooks.set(address, hook);
  }

  /**
   * Resolve the per-message fan-out verdict for a `messages/send`
   * (#560). Looks up the registered handler by `tmEndpointAddress`,
   * dispatches either the in-process `MessageAuthorizeHook` or the
   * remote `messages/authorize` S→C RPC, applies the uniform fail-
   * closed envelope, and returns a verdict the
   * `MessageService.sendCommit` caller can switch on.
   *
   * Fail-closed posture (mirrors `runAuthorizeDispatch` per #461 r3
   * R3/R4): timeout / RPC error / handler throw / decode failure all
   * synthesize `Block { reason: "tm_unreachable" }` (or
   * `"messages/authorize timeout"` / `"messages/authorize error"`,
   * matching `dispatch/authorize`'s wording where the cause is known).
   *
   * Default policy when no hook is registered for the address:
   * `Forward { recipients: participants \ sender }`. Default-DM and
   * default-group's in-process registrations return exactly this —
   * preserves today's broadcast behavior with zero wire chatter.
   *
   * The address-keyed map (`messageAuthorizeHooks`) is the C2 design
   * pin: separate registry from the appId-keyed `hooks`, identical
   * shape (`Map&lt;TKey, Hook&lt;TContext, TResult>>`). The hook-shape
   * unification is the v4 design pin (architect risk R13).
   */
  runMessageAuthorize(
    tmEndpointAddress: EndpointAddress,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const route = this.messageAuthorizeRoute(tmEndpointAddress);
    if (!route.inProcess && !route.remote) {
      return this.defaultMessageAuthorize(ctx);
    }

    const timeoutMs = this.messageAuthorizeTimeoutMs(route.remoteAppId);
    const taskId = ctx.taskId;
    const appId = ctx.appId;

    return this.wrapHookEffectWithEnvelope<MessageAuthorizeResult>({
      raw: this.messageAuthorizeRaw(
        ctx,
        route.remoteAppId ?? appId,
        route.remote,
        route.inProcess,
      ),
      timeoutMs,
      timeoutLogMessage: "messages/authorize timed out",
      timeoutLogContext: {
        taskId,
        appId,
        tmEndpointAddress,
        timeoutMs,
      },
      errorLogMessage: "messages/authorize error",
      errorLogContext: { taskId, appId, tmEndpointAddress },
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

  private messageAuthorizeRoute(
    tmEndpointAddress: EndpointAddress,
  ): MessageAuthorizeRoute {
    const inProcess = this.messageAuthorizeHooks.get(tmEndpointAddress);
    const remoteAppId = appIdFromTmEndpointAddress(tmEndpointAddress);
    if (remoteAppId === null) {
      return { inProcess, remoteAppId, remote: undefined };
    }
    return {
      inProcess,
      remoteAppId,
      remote: this.remoteRegistrations.get(remoteAppId),
    };
  }

  private messageAuthorizeTimeoutMs(appId: string | null): number {
    if (appId === null) return DEFAULT_APP_HOOK_TIMEOUT_MS;
    const manifest = this.manifests.get(appId);
    return (
      manifest?.hooks?.message_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS
    );
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
    ctx: MessageAuthorizeContext,
    appId: string,
    remote: RemoteRegistration | undefined,
    inProcess: MessageAuthorizeHook | undefined,
  ): Effect.Effect<MessageAuthorizeResult, Error> {
    if (remote) {
      return this.runRemoteHookEffect({
        appId,
        definition: MessagesAuthorize,
        connectionId: remote.connectionId,
        params: this.messageAuthorizeParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.verdict));
    }
    return this.runInProcessHookEffect<
      MessageAuthorizeContext,
      MessageAuthorizeResult
    >((ctxWithSignal) => inProcess!(ctxWithSignal), ctx);
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
    this.hooks.clear();
    this.remoteRegistrations.clear();
    this.messageAuthorizeHooks.clear();
  }

  // ── Uniform hook dispatch (in-process + remote) ────────────────────
  //
  // Per architect plan §3.4: every hook returns `Effect<Verdict, never>`
  // regardless of source. The branching between in-process and remote is
  // INSIDE the dispatch helpers; call sites observe one type. Failure
  // modes (timeout, throw, RPC error, NotConnectedError, decode failure)
  // collapse into fail-closed verdicts (`deny`).
  //
  // Multi-app composition (architect plan §3.4: "Effect.forEach in
  // registration order, first deny short-circuits") is implemented by
  // {@link dispatchAcrossAppsWithDenyShortCircuit} below. Today every
  // session is bound to a single appId so the iteration is len-1; the
  // combinator is forward-compatible for multi-app sessions.

  private authorizeDispatchParamsForWire(
    ctx: TaskAuthorizeDispatchContext,
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
    appId: string;
    definition: D;
    connectionId: string;
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
