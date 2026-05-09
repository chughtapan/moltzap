import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import { sendRpcToClient } from "../transport/connection.js";
import type {
  ConnectionManager,
  MoltZapConnection,
} from "../transport/connection.js";
import { logger } from "../logger.js";
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
import type { ConversationId, MessageId } from "@moltzap/protocol/task";
import {
  type AppHooks,
  type DispatchAdmissionResult,
  type MessageAuthorizeContext,
  type MessageAuthorizeHook,
  type MessageAuthorizeResult,
  type TaskAuthorizeDispatchContext,
  type TaskAuthorizeDispatchHook,
} from "./hooks.js";
import type { EndpointAddress } from "@moltzap/protocol/network";
import { Data, Effect, Option } from "effect";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";
import { lookupAppForConversation } from "./conversation-app-lookup.js";
import type { LeaseRegistry } from "./lease-registry.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * For app-bound conversations whose TM IS the moderator agent (the
 * common case per architect plan §3 + prereq 2 §3 — the
 * `requireConversationAdminAuthority` gate accepts only this shape for
 * `app_id IS NOT NULL`), `tasks.tm_endpoint_address` is the wire
 * address `tm:agent:<moderatorAgentId>`. Recover the agentId so the
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

export class AppHost {
  private manifests = new Map<string, AppManifest>();
  private contactService: ContactService | null = null;
  private hooks = new Map<string, AppHooks>();

  /**
   * #560: send-side fan-out hooks keyed by `EndpointAddress`. The
   * lookup key for `messages/authorize` is the parent task's
   * `tm_endpoint_address` (always populated post-#461 R12), NOT an
   * appId. Default-DM and default-group register at boot under
   * `DEFAULT_DM_TM_ADDRESS` / `DEFAULT_GROUP_TM_ADDRESS`; app TMs
   * register under their `tm:app:<uuid>` address; future custom TMs
   * (e.g., `tm:agent:<id>`) register under that.
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
  private remoteRegistrations = new Map<string, { connectionId: string }>();

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
    private db: Kysely<Database>,
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
    logger.info({ appId: manifest.appId }, "App registered");
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
    logger.info(
      { appId: manifest.appId, connectionId },
      "Remote app registered",
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
      logger.info({ appId }, "Remote app unregistered");
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
    const existing = this.hooks.get(appId) ?? {};
    existing.taskAuthorizeDispatch = handler;
    this.hooks.set(appId, existing);
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
  enqueueDispatchRequest(args: {
    conversationId: ConversationId;
    recipientAgentId: AgentId;
    recipientConnectionId: string;
    messageId: MessageId;
    senderAgentId: AgentId;
    parts?: Part[];
    attempt?: number;
    receivedAt?: string;
    clock?: LogicalClock;
    pending?: ReadonlyArray<{
      messageId: MessageId;
      conversationId: ConversationId;
      senderAgentId: AgentId;
      createdAt: string;
      receivedAt: string;
      clock?: LogicalClock;
      parts?: Part[];
    }>;
  }): Effect.Effect<
    { leaseId: LeaseId; dispatchId: DispatchId },
    never,
    never
  > {
    const registry = this.leaseRegistry;
    if (!registry) {
      return Effect.dieMessage(
        "AppHost.enqueueDispatchRequest: LeaseRegistry not wired (call setLeaseRegistry post-construction)",
      );
    }
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const lookup = yield* lookupAppForConversation(
          this.db,
          args.conversationId,
        );

        // Resolve appId + tmEndpointAddress from the join. For
        // NoAppSession / NotFound we still need a tmEndpointAddress to
        // record in the binding tuple (the moderator-connection field
        // doubles as a "no moderator" sentinel via empty string).
        let appId = "";
        let taskId: import("@moltzap/protocol/task").TaskId =
          "" as import("@moltzap/protocol/task").TaskId;
        let tmEndpointAddress = "";
        let moderatorConnectionId = "";

        if (lookup._tag === "AppBound") {
          appId = lookup.appId;
          taskId = lookup.taskId;
          // Look up tm_endpoint_address from tasks for binding-tuple audit.
          const taskRow = yield* takeFirstOption(
            this.db
              .selectFrom("tasks")
              .select(["tm_endpoint_address"])
              .where("id", "=", lookup.taskId),
          );
          tmEndpointAddress = Option.match(taskRow, {
            onNone: () => "",
            onSome: (r) => r.tm_endpoint_address,
          });
          // Moderator connection = the connection that ran apps/register
          // for this app. May be empty if the moderator is offline.
          const remote = this.remoteRegistrations.get(lookup.appId);
          moderatorConnectionId = remote?.connectionId ?? "";
        }

        const minted = yield* registry.mint({
          recipientAgentId: args.recipientAgentId,
          recipientConnectionId: args.recipientConnectionId,
          moderatorConnectionId,
          taskId,
          conversationId: args.conversationId,
          tmEndpointAddress,
          appId,
        });

        // Fork the moderator round-trip. The forked Effect resolves the
        // lease — the recipient observes the verdict via
        // `dispatch/release` notification. Track the fiber in the
        // registry so PENDING → ABANDONED on recipient disconnect can
        // interrupt the in-flight hook call (architect §3 state-
        // machine row "PENDING + recipient connection close").
        const roundTripFiber = yield* Effect.forkDaemon(
          this.runForkedDispatchRoundTrip(registry, minted.leaseId, lookup, {
            conversationId: args.conversationId,
            recipientAgentId: args.recipientAgentId,
            messageId: args.messageId,
            senderAgentId: args.senderAgentId,
            parts: args.parts,
            attempt: args.attempt,
            receivedAt: args.receivedAt,
            clock: args.clock,
            pending: args.pending,
            tmEndpointAddress,
          }),
        );
        yield* registry.attachRoundTripFiber(minted.leaseId, roundTripFiber);

        return minted;
      }),
    );
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
    lookup: import("./conversation-app-lookup.js").ConversationAppLookup,
    params: {
      conversationId: ConversationId;
      recipientAgentId: AgentId;
      messageId: MessageId;
      senderAgentId: AgentId;
      parts?: Part[];
      attempt?: number;
      receivedAt?: string;
      clock?: LogicalClock;
      pending?: ReadonlyArray<{
        messageId: MessageId;
        conversationId: ConversationId;
        senderAgentId: AgentId;
        createdAt: string;
        receivedAt: string;
        clock?: LogicalClock;
        parts?: Part[];
      }>;
      /**
       * Captured at mint time from `tasks.tm_endpoint_address`. Used in
       * the deny arm to derive the moderator's agentId for
       * `removeParticipant` (architect §3 + epic decision #8).
       */
      tmEndpointAddress: string;
    },
  ): Effect.Effect<void, never, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        switch (lookup._tag) {
          case "ConversationArchived":
            yield* registry
              .resolve(leaseId, {
                _tag: "deny",
                reason: "conversation_archived",
              })
              .pipe(Effect.catchAll(() => Effect.void));
            return;
          case "ConversationNotFound":
          case "NoAppSession":
            yield* registry
              .resolve(leaseId, { _tag: "grant" })
              .pipe(Effect.catchAll(() => Effect.void));
            return;
          case "AppBound": {
            const isRemote = this.remoteRegistrations.has(lookup.appId);
            const appHooks = this.hooks.get(lookup.appId);
            if (!isRemote && !appHooks?.taskAuthorizeDispatch) {
              // Risk #5: synthesized hold (NOT verdict-deny).
              yield* registry
                .resolve(leaseId, {
                  _tag: "hold",
                  reason: "moderator_unavailable",
                })
                .pipe(Effect.catchAll(() => Effect.void));
              return;
            }

            const agentOpt = yield* takeFirstOption(
              this.db
                .selectFrom("agents")
                .select("owner_user_id")
                .where("id", "=", params.recipientAgentId),
            );
            const agent = Option.getOrNull(agentOpt);

            const ctx: TaskAuthorizeDispatchContext = {
              conversationId: params.conversationId,
              recipient: {
                agentId: params.recipientAgentId,
                ownerId: agent?.owner_user_id ?? "",
              },
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

            const verdict = yield* this.dispatchAuthorizeHook(
              lookup.appId,
              ctx,
            );

            // Map admission decision → registry verdict.
            const registryVerdict =
              verdict.decision === "grant"
                ? {
                    _tag: "grant" as const,
                    ...(verdict.leaseTimeoutMs !== undefined
                      ? { leaseTimeoutMs: verdict.leaseTimeoutMs }
                      : {}),
                  }
                : verdict.decision === "deny"
                  ? {
                      _tag: "deny" as const,
                      ...(verdict.reason !== undefined
                        ? { reason: verdict.reason }
                        : {}),
                    }
                  : {
                      _tag: "hold" as const,
                      ...(verdict.reason !== undefined
                        ? { reason: verdict.reason }
                        : {}),
                    };
            yield* registry
              .resolve(leaseId, registryVerdict)
              .pipe(Effect.catchAll(() => Effect.void));
            // Architect §3 + epic decision #8: verdict-deny removes the
            // recipient from THE conversation. Synthesized timeout-deny
            // (wrapHookEffectWithEnvelope onTimeout) is verdict-deny —
            // architect risk #3 names it explicitly. Synthesized infra-
            // hold (handled in the "no hook registered" branch above)
            // does NOT call removeParticipant — that is risk #5
            // (moderator unavailable shouldn't mass-evict).
            //
            // Authority: requireConversationAdminAuthority (prereq 2)
            // for app-bound conversations gates on
            // `task.tm_endpoint_address === endpointAddressForAgent(caller)`.
            // For app-bound + moderator-IS-TM, the task's address is
            // `tm:agent:<moderatorAgentId>` — we parse the agentId out
            // and pass it as the requester. The check passes naturally.
            if (verdict.decision === "deny") {
              const svc = this.conversationService;
              const moderatorAgentId = parseModeratorAgentIdFromTm(
                params.tmEndpointAddress,
              );
              if (svc !== null && moderatorAgentId !== null) {
                yield* svc
                  .removeParticipant(
                    params.conversationId,
                    params.recipientAgentId,
                    moderatorAgentId,
                  )
                  .pipe(
                    Effect.catchAll((cause) =>
                      Effect.logWarning("deny → removeParticipant failed").pipe(
                        Effect.annotateLogs({
                          conversationId: params.conversationId,
                          recipientAgentId: params.recipientAgentId,
                          cause: String(cause),
                        }),
                      ),
                    ),
                  );
              }
            }
            return;
          }
          default: {
            const _absurd: never = lookup;
            return _absurd;
          }
        }
      }),
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
    const inProcess = this.hooks.get(appId)?.taskAuthorizeDispatch;
    if (!remote && !inProcess) {
      return Effect.succeed({ decision: "grant" as const });
    }
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.dispatch_authorize?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    const raw: Effect.Effect<DispatchAdmissionResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: DispatchAuthorize,
          connectionId: remote.connectionId,
          params: this.authorizeDispatchParamsForWire(ctx),
        }).pipe(Effect.map((envelope) => envelope.admission))
      : this.runInProcessHookEffect<
          TaskAuthorizeDispatchContext,
          DispatchAdmissionResult
        >((ctxWithSignal) => inProcess!(ctxWithSignal), ctx);

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw,
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
   * #560: Register an in-process `messageAuthorize` handler keyed by
   * `EndpointAddress`. Default-DM and default-group register at boot
   * (in `app-tm-registry.ts` or wherever default TMs bootstrap);
   * apps that hold their own `tm:app:<uuid>` address register at
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
   * #560 v4 — generic hook runner shared by every authorization hook
   * registry. Encapsulates the lookup + in-process-vs-remote branch +
   * fail-closed envelope. Specific runners (`runMessageAuthorize`,
   * future `runAuthorizeDispatch` refactor) become thin wrappers that
   * supply the registry and the synthetic fallback verdict.
   *
   *   private runHook<TKey, TContext, TResult>(opts: {
   *     registry: Map<TKey, Hook<TContext, TResult>>;
   *     key: TKey;
   *     ctx: TContext;
   *     manifestTimeoutMs: number;
   *     onTimeout: () => TResult;
   *     onError: () => TResult;
   *     defaultWhenAbsent: () => TResult;
   *   }): Effect.Effect<TResult, never>;
   *
   * The runner reuses `wrapHookEffectWithEnvelope` (`:763@adc2e18`)
   * for the timeout + fail-closed wrapper; supplies in-process or
   * remote dispatch via `runInProcessHookEffect` /
   * `runRemoteHookEffect`. Refactoring the existing
   * `dispatchAuthorizeHook` (`:550@adc2e18`) onto this shape is OUT
   * of scope for this PR (architect §5 NOT-in-scope; tracked as a
   * follow-up). The new `runMessageAuthorize` below is the FIRST
   * caller of the unified shape; the existing dispatch path keeps its
   * current implementation until the follow-up lands.
   *
   * Stub: `implement-*` fills in the body. Body shape: lookup, branch
   * on `remoteRegistrations.has(...)`, run, envelope, return.
   *
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
   * shape (`Map<TKey, Hook<TContext, TResult>>`). The hook-shape
   * unification is the v4 design pin (architect risk R13).
   */
  runMessageAuthorize(
    tmEndpointAddress: EndpointAddress,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    return Effect.dieMessage(
      `AppHost.runMessageAuthorize: not implemented (#560 architect stub) for ${tmEndpointAddress} appId=${ctx.appId}`,
    );
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
    ctx: TaskAuthorizeDispatchContext,
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
      return yield* sendRpcToClient(conn, opts.definition, opts.params).pipe(
        Effect.mapError(
          (err) =>
            new RemoteHookError({
              appId: opts.appId,
              method,
              connectionId: opts.connectionId,
              reason: `task-callback RPC failed: ${errorMessage(err)}`,
              cause: err,
            }),
        ),
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
