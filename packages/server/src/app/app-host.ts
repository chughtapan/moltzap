import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Broadcaster } from "../ws/broadcaster.js";
import { sendRpcToClient } from "../ws/connection.js";
import type { ConnectionManager, MoltZapConnection } from "../ws/connection.js";
import type { UserService } from "../services/user.service.js";
import { logger } from "../logger.js";
import type {
  AnyAppCallbackRpcDefinition,
  AppManifest,
  LogicalClock,
  ParamsOf,
  Part,
  ResultOf,
} from "@moltzap/protocol";
import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  agentId as protocolAgentId,
  conversationId as protocolConversationId,
  messageId as protocolMessageId,
} from "@moltzap/protocol";
import {
  type AppHooks,
  type BeforeDispatchContext,
  type BeforeDispatchHook,
  type BeforeMessageDeliveryContext,
  type BeforeMessageDeliveryHook,
  type DispatchAdmissionResult,
  type HookResult,
  type OnCloseHook,
  type OnSessionActiveHook,
} from "./hooks.js";
import { Data, Effect, Option } from "effect";
import { RpcFailure } from "../runtime/index.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_APP_HOOK_TIMEOUT_MS = 5000;

export interface ContactService {
  areInContact(userIdA: string, userIdB: string): Effect.Effect<boolean, never>;
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
   * Remote-app routing table. An entry exists iff `registerRemoteApp` was
   * called for `appId`; the value records which WS connection serves the
   * app's hook RPCs. Looked up at dispatch time (not registration time)
   * so the connection can be closed and re-resolved without re-registering
   * the app — the Scope finalizer on the old connection drains its
   * pending Deferreds with `AppDisconnected`, which the dispatch envelope
   * maps to fail-closed verdicts.
   *
   * Disjoint with `hooks` per-app: a given `appId` is either in-process
   * (entries in `hooks`) or remote (entry here), never both. The dispatch
   * helpers prefer the remote entry when present — `registerRemoteApp`
   * is the explicit promotion path.
   */
  private remoteRegistrations = new Map<string, { connectionId: string }>();
  private conversationToSession = new Map<
    string,
    { id: string; appId: string }
  >();
  private sessionToConversations = new Map<string, Set<string>>();

  constructor(
    private db: Kysely<Database>,
    private broadcaster: Broadcaster,
    private connections: ConnectionManager,
    /** null → no user validation (admit all owners). */
    private userService: UserService | null,
  ) {}

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    logger.info({ appId: manifest.appId }, "App registered");
  }

  /**
   * Register an app whose hook handlers run in a remote process (typically
   * an `@moltzap/app-sdk` client connected over WebSocket). Hook RPCs
   * (`apps/onBeforeDispatch`, `onBeforeMessageDelivery`, `onSessionActive`,
   * `onClose`) are dispatched to `connectionId` via
   * {@link sendRpcToClient}; verdicts decode through the schemas defined in
   * `hooks.ts` and feed the same fail-closed envelope as in-process hooks.
   *
   * Promotion: a remote registration takes precedence over any prior
   * in-process hook registrations for the same `appId`. The
   * {@link AppRegistrationSource} discrimination is internal — call sites
   * (`runBeforeDispatch` / `runBeforeMessageDelivery` / etc.) consume one
   * uniform `Effect<Verdict, never>` regardless of source per architect
   * plan §3.4 ("No branching at the call site between in-process and
   * remote").
   *
   * Disconnect handling: when `connectionId` later goes away, every
   * pending Deferred for that connection's appCallback RPCs fails with
   * `AppDisconnected` via the connection's Scope finalizer. The dispatch
   * envelope catches `AppDisconnected` (and every other `AppCallbackRpcError`
   * variant) and synthesizes a fail-closed verdict — `deny` for
   * admission hooks, `block: true` for `before_message_delivery`, void +
   * log for lifecycle hooks. Callers do not need to
   * call {@link unregisterRemoteApp} on disconnect; the registration
   * keeps pointing at the dead connection id and dispatches keep
   * fail-closed until the app re-registers (typically via `apps/register`
   * after reconnecting). Operators that want eager cleanup can call
   * {@link unregisterRemoteApp} from a connection-close hook.
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

  isAttachedToActiveSession(conversationId: string): boolean {
    return this.conversationToSession.has(conversationId);
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

  onBeforeMessageDelivery(
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeMessageDelivery = handler;
    this.hooks.set(appId, existing);
  }

  onBeforeDispatch(appId: string, handler: BeforeDispatchHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.beforeDispatch = handler;
    this.hooks.set(appId, existing);
  }

  onSessionClose(appId: string, handler: OnCloseHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onClose = handler;
    this.hooks.set(appId, existing);
  }

  onSessionActive(appId: string, handler: OnSessionActiveHook): void {
    const existing = this.hooks.get(appId) ?? {};
    existing.onSessionActive = handler;
    this.hooks.set(appId, existing);
  }

  runBeforeDispatch(
    conversationId: string,
    recipientAgentId: string,
    params: {
      messageId: string;
      senderAgentId: string;
      parts?: Part[];
      attempt?: number;
      receivedAt?: string;
      clock?: LogicalClock;
      pending?: ReadonlyArray<{
        messageId: string;
        conversationId: string;
        senderAgentId: string;
        createdAt: string;
        receivedAt: string;
        clock?: LogicalClock;
        parts?: Part[];
      }>;
    },
  ): Effect.Effect<DispatchAdmissionResult, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const session = this.conversationToSession.get(conversationId);
        if (!session) {
          const conversationOpt = yield* takeFirstOption(
            this.db
              .selectFrom("conversations")
              .select("archived_at")
              .where("id", "=", conversationId),
          );
          const conversation = Option.getOrNull(conversationOpt);
          if (conversation?.archived_at) {
            return {
              decision: "deny" as const,
              reason: "conversation_archived",
            };
          }
          return { decision: "grant" as const };
        }

        const isRemote = this.remoteRegistrations.has(session.appId);
        const appHooks = this.hooks.get(session.appId);

        if (!isRemote && !appHooks?.beforeDispatch) {
          return { decision: "grant" as const };
        }

        const agentOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select("owner_user_id")
            .where("id", "=", recipientAgentId),
        );
        const agent = Option.getOrNull(agentOpt);

        // ctx without `signal` — the in-process dispatch helper attaches
        // the AbortController-bound signal at call time. Remote dispatch
        // strips signal-shaped fields via `contextForWire` before encode.
        const ctx: BeforeDispatchContext = {
          conversationId,
          recipient: {
            agentId: recipientAgentId,
            ownerId: agent?.owner_user_id ?? "",
          },
          message: {
            id: params.messageId,
            senderAgentId: params.senderAgentId,
            parts: params.parts,
          },
          sessionId: session.id,
          appId: session.appId,
          attempt: params.attempt ?? 0,
          receivedAt: params.receivedAt,
          clock: params.clock,
          pending: params.pending,
          // Placeholder; the in-process dispatch helper overrides with
          // its own AbortController-tied signal. Remote dispatch elides.
          signal: new AbortController().signal,
        };

        // Uniform Effect dispatch — in-process / remote choice is INSIDE
        // the helper. Per architect plan §3.4: "No branching at the call
        // site between in-process and remote." Composition uses the
        // forEach-with-deny-short-circuit combinator (degenerate to N=1
        // today; forward-compatible for multi-app sessions).
        return yield* this.dispatchAcrossAppsWithDenyShortCircuit<DispatchAdmissionResult>(
          [session.appId],
          (v) => v.decision === "deny",
          { decision: "grant" as const },
          (appId) => this.dispatchBeforeDispatchHook(appId, ctx),
        );
      }),
    );
  }

  runBeforeMessageDelivery(
    conversationId: string,
    senderAgentId: string,
    parts: Part[],
    replyToId?: string,
    dispatchLeaseId?: string,
  ): Effect.Effect<{ result: HookResult; appId: string } | null, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const session = this.conversationToSession.get(conversationId);
        if (!session) return null;

        const isRemote = this.remoteRegistrations.has(session.appId);
        const appHooks = this.hooks.get(session.appId);

        if (!isRemote && !appHooks?.beforeMessageDelivery) {
          return null;
        }

        const agentOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select("owner_user_id")
            .where("id", "=", senderAgentId),
        );
        const agent = Option.getOrNull(agentOpt);

        const ctx: BeforeMessageDeliveryContext = {
          conversationId,
          sender: {
            agentId: senderAgentId,
            ownerId: agent?.owner_user_id ?? "",
          },
          message: { parts, replyToId, dispatchLeaseId },
          sessionId: session.id,
          appId: session.appId,
          // Placeholder; the in-process dispatch helper overrides with
          // its AbortController-tied signal. Remote dispatch elides via
          // `contextForWire`.
          signal: new AbortController().signal,
        };

        // Uniform Effect dispatch — in-process / remote choice INSIDE
        // the helper. Multi-app composition uses the forEach-with-block-
        // short-circuit combinator (degenerate to N=1 today).
        const result =
          yield* this.dispatchAcrossAppsWithDenyShortCircuit<HookResult>(
            [session.appId],
            (v) => v.block,
            { block: false },
            (appId) => this.dispatchBeforeMessageDeliveryHook(appId, ctx),
          );
        return { result, appId: session.appId };
      }),
    );
  }

  /** Clear in-memory state. Called on shutdown. */
  destroy(): void {
    this.hooks.clear();
    this.remoteRegistrations.clear();
    this.conversationToSession.clear();
    this.sessionToConversations.clear();
  }

  private subscribeToConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.add(convId);
    }
  }

  private unsubscribeFromConversation(agentId: string, convId: string): void {
    for (const conn of this.connections.getByAgent(agentId)) {
      conn.conversationIds.delete(convId);
    }
  }

  // ── Uniform hook dispatch (in-process + remote) ────────────────────
  //
  // Per architect plan §3.4: every hook returns `Effect<Verdict, never>`
  // regardless of source. The branching between in-process and remote is
  // INSIDE the dispatch helpers; call sites observe one type. Failure
  // modes (timeout, throw, RPC error, AppDisconnected, decode failure)
  // collapse into fail-closed verdicts for admission hooks (`deny` /
  // `block`), or void + log for lifecycle hooks.
  //
  // Multi-app composition (architect plan §3.4: "Effect.forEach in
  // registration order, first deny short-circuits") is implemented by
  // {@link dispatchAcrossAppsWithDenyShortCircuit} below. Today every
  // session is bound to a single appId so the iteration is len-1; the
  // combinator is forward-compatible for multi-app sessions.

  /**
   * Strip non-wire-safe fields from a hook context so it can be sent over
   * the appCallback RPC. Currently the only such field is `signal: AbortSignal`,
   * which has meaning only in-process. Returns a new object — does not
   * mutate `ctx`.
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

  private beforeDispatchParamsForWire(
    ctx: BeforeDispatchContext,
  ): ParamsOf<typeof AppsOnBeforeDispatch> {
    const wire = this.contextForWire(ctx);
    return {
      sessionId: wire.sessionId,
      appId: wire.appId,
      conversationId: protocolConversationId(wire.conversationId),
      recipient: {
        ...wire.recipient,
        agentId: protocolAgentId(wire.recipient.agentId),
      },
      message: {
        id: protocolMessageId(wire.message.id),
        senderAgentId: protocolAgentId(wire.message.senderAgentId),
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
              messageId: protocolMessageId(pending.messageId),
              conversationId: protocolConversationId(pending.conversationId),
              senderAgentId: protocolAgentId(pending.senderAgentId),
              createdAt: pending.createdAt,
              receivedAt: pending.receivedAt,
              ...(pending.clock !== undefined ? { clock: pending.clock } : {}),
              ...(pending.parts !== undefined ? { parts: pending.parts } : {}),
            })),
          }
        : {}),
    };
  }

  private beforeMessageDeliveryParamsForWire(
    ctx: BeforeMessageDeliveryContext,
  ): ParamsOf<typeof AppsOnBeforeMessageDelivery> {
    const wire = this.contextForWire(ctx);
    return {
      sessionId: wire.sessionId,
      appId: wire.appId,
      conversationId: protocolConversationId(wire.conversationId),
      sender: {
        ...wire.sender,
        agentId: protocolAgentId(wire.sender.agentId),
      },
      message: {
        parts: wire.message.parts,
        ...(wire.message.dispatchLeaseId !== undefined
          ? { dispatchLeaseId: wire.message.dispatchLeaseId }
          : {}),
        ...(wire.message.replyToId !== undefined
          ? { replyToId: protocolMessageId(wire.message.replyToId) }
          : {}),
      },
    };
  }

  /**
   * Run an in-process Promise-returning hook under an `AbortController`
   * tied to fiber interrupts (e.g., from `Effect.timeout` upstream). The
   * controller is wired so:
   *   - timeout fires → fiber interrupts → `Effect.onInterrupt` aborts
   *   - hook throws / rejects → `tapErrorCause` aborts
   * preserving the abort-on-timeout / abort-on-throw guarantees that
   * `30-app-hooks.integration.test.ts:359-435` covers.
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
   * any failure (`AppDisconnected`, RPC response error, socket error,
   * schema decode failure, missing connection) lands in the failure
   * channel for the dispatch envelope to map to fail-closed.
   *
   * Result decoding happens in `sendRpcToClient`, where the descriptor
   * that constructed the frame validates the response against its TypeBox
   * result schema before this method can observe a value.
   */
  private runRemoteHookEffect<D extends AnyAppCallbackRpcDefinition>(opts: {
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
        // gone away. Treat identically to mid-flight `AppDisconnected`
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
              reason: `appCallback RPC failed: ${errorMessage(err)}`,
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
   *   - any other error (handler throw, RPC error, `AppDisconnected`,
   *     schema decode failure) → logs an error, returns the error
   *     verdict from `onError`.
   *
   * For admission hooks `onTimeout` / `onError` synthesize fail-closed
   * verdicts (`deny` / `block: true`); for lifecycle hooks they return
   * `Effect.void`. The error-channel narrowing to `never` is the
   * contract that lets call sites compose hooks via `Effect.forEach`
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

  /**
   * Uniform `before_dispatch` dispatch — the in-process / remote choice
   * is made HERE; callers see one signature and one return type. Returns
   * `{ decision: "grant" }` when no hook is registered. Fail-closed on
   * timeout / handler error / RPC failure per architect plan §3.4.
   */
  private dispatchBeforeDispatchHook(
    appId: string,
    ctx: BeforeDispatchContext,
  ): Effect.Effect<DispatchAdmissionResult, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.beforeDispatch;
    if (!remote && !inProcess) {
      return Effect.succeed({ decision: "grant" as const });
    }
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.before_dispatch?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<DispatchAdmissionResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: AppsOnBeforeDispatch,
          connectionId: remote.connectionId,
          params: this.beforeDispatchParamsForWire(ctx),
        }).pipe(Effect.map((envelope) => envelope.admission))
      : this.runInProcessHookEffect<
          BeforeDispatchContext,
          DispatchAdmissionResult
        >((ctxWithSignal) => inProcess!(ctxWithSignal), ctx);

    return this.wrapHookEffectWithEnvelope<DispatchAdmissionResult>({
      raw,
      timeoutMs,
      timeoutLogMessage: "before_dispatch hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "before_dispatch hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => ({
        decision: "deny" as const,
        reason: "before_dispatch hook timed out",
      }),
      onError: () => ({
        decision: "deny" as const,
        reason: "before_dispatch hook error",
      }),
    });
  }

  /**
   * Uniform `before_message_delivery` dispatch. Fail-CLOSED to
   * `{ block: true }` on timeout/throw/RPC-failure per architect plan §3.4
   * (verified against `30-app-hooks.integration.test.ts:229-272,296-357`).
   */
  private dispatchBeforeMessageDeliveryHook(
    appId: string,
    ctx: BeforeMessageDeliveryContext,
  ): Effect.Effect<HookResult, never> {
    const remote = this.remoteRegistrations.get(appId);
    const inProcess = this.hooks.get(appId)?.beforeMessageDelivery;
    if (!remote && !inProcess) {
      // No-hook short-circuit: caller treats `block: false` and no patch as
      // "pass through unchanged", same as the legacy `null` outcome.
      return Effect.succeed({ block: false });
    }
    const manifest = this.manifests.get(appId);
    const timeoutMs =
      manifest?.hooks?.before_message_delivery?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const sessionId = ctx.sessionId;

    const raw: Effect.Effect<HookResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: AppsOnBeforeMessageDelivery,
          connectionId: remote.connectionId,
          params: this.beforeMessageDeliveryParamsForWire(ctx),
        })
      : this.runInProcessHookEffect<BeforeMessageDeliveryContext, HookResult>(
          (ctxWithSignal) => inProcess!(ctxWithSignal),
          ctx,
        );

    return this.wrapHookEffectWithEnvelope<HookResult>({
      raw,
      timeoutMs,
      timeoutLogMessage: "before_message_delivery hook timed out",
      timeoutLogContext: { sessionId, appId, timeoutMs },
      errorLogMessage: "before_message_delivery hook error",
      errorLogContext: { sessionId, appId },
      onTimeout: () => ({
        block: true,
        reason: "before_message_delivery hook timed out",
      }),
      onError: () => ({
        block: true,
        reason: "before_message_delivery hook error",
      }),
    });
  }

  /**
   * Compose admission verdicts across multiple registered apps for the
   * same hook in registration order, short-circuiting on the first
   * `deny` / `block`. Architect plan §3.4 names `Effect.forEach` as the
   * combinator; we use the equivalent sequential `Effect.gen` reduce so
   * the deny-as-short-circuit semantic reads at the call site without
   * needing a `catchTag` round-trip through a synthetic failure channel.
   *
   * Today every session is bound to a single appId so this is invoked
   * with a len-1 array; the helper exists so multi-app sessions slot in
   * without a call-site rewrite.
   */
  private dispatchAcrossAppsWithDenyShortCircuit<Verdict>(
    appIds: readonly string[],
    isShortCircuit: (v: Verdict) => boolean,
    defaultVerdict: Verdict,
    perApp: (appId: string) => Effect.Effect<Verdict, never>,
  ): Effect.Effect<Verdict, never> {
    return Effect.gen(function* () {
      let verdict: Verdict = defaultVerdict;
      for (const appId of appIds) {
        verdict = yield* perApp(appId);
        if (isShortCircuit(verdict)) return verdict;
      }
      return verdict;
    });
  }
}
