import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import { sendRpcToClient } from "../ws/connection.js";
import type { ConnectionManager, MoltZapConnection } from "../ws/connection.js";
import { logger } from "../logger.js";
import type {
  AnyTaskCallbackRpcDefinition,
  AppManifest,
  LogicalClock,
  ParamsOf,
  Part,
  ResultOf,
} from "@moltzap/protocol";
import { TaskAuthorizeDispatch } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/task";
import {
  type AppHooks,
  type DispatchAdmissionResult,
  type TaskAuthorizeDispatchContext,
  type TaskAuthorizeDispatchHook,
} from "./hooks.js";
import { Data, Effect, Option } from "effect";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";
import { lookupAppForConversation } from "./conversation-app-lookup.js";

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
   * pending Deferreds with `NotConnectedError`, which the dispatch envelope
   * maps to fail-closed verdicts.
   *
   * Disjoint with `hooks` per-app: a given `appId` is either in-process
   * (entries in `hooks`) or remote (entry here), never both. The dispatch
   * helpers prefer the remote entry when present — `registerRemoteApp`
   * is the explicit promotion path.
   */
  private remoteRegistrations = new Map<string, { connectionId: string }>();

  constructor(
    private db: Kysely<Database>,
    private connections: ConnectionManager,
  ) {}

  registerApp(manifest: AppManifest): void {
    this.manifests.set(manifest.appId, manifest);
    logger.info({ appId: manifest.appId }, "App registered");
  }

  /**
   * Register an app whose `task/authorizeDispatch` admission round-trips
   * run in a remote process (typically a WebSocket client speaking the
   * `task/authorizeDispatch` protocol). The verb dispatches via
   * {@link sendRpcToClient}; verdicts decode through the schemas in
   * `hooks.ts` and feed the same fail-closed envelope as in-process hooks.
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

  runAuthorizeDispatch(
    conversationId: ConversationId,
    recipientAgentId: AgentId,
    params: {
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
    },
  ): Effect.Effect<DispatchAdmissionResult> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const lookup = yield* lookupAppForConversation(this.db, conversationId);
        switch (lookup._tag) {
          case "ConversationArchived":
            return {
              decision: "deny" as const,
              reason: "conversation_archived",
            };
          case "ConversationNotFound":
          case "NoAppSession":
            return { decision: "grant" as const };
          case "AppBound": {
            const isRemote = this.remoteRegistrations.has(lookup.appId);
            const appHooks = this.hooks.get(lookup.appId);
            if (!isRemote && !appHooks?.taskAuthorizeDispatch) {
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
            const ctx: TaskAuthorizeDispatchContext = {
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
              taskId: lookup.taskId,
              appId: lookup.appId,
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
              [lookup.appId],
              (v) => v.decision === "deny",
              { decision: "grant" as const },
              (appId) => this.dispatchAuthorizeDispatchHook(appId, ctx),
            );
          }
          default: {
            // Exhaustiveness gate: a future tag added to ConversationAppLookup
            // forces an update here at compile time (Principle 4).
            const _absurd: never = lookup;
            return _absurd;
          }
        }
      }),
    );
  }

  /** Clear in-memory state. Called on shutdown. */
  destroy(): void {
    this.hooks.clear();
    this.remoteRegistrations.clear();
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
  ): ParamsOf<typeof TaskAuthorizeDispatch> {
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
   * For `task/authorizeDispatch` `onTimeout` / `onError` synthesize a
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

  /**
   * Uniform `task/authorizeDispatch` dispatch — the in-process / remote
   * choice is made HERE; callers see one signature and one return type.
   * Returns `{ decision: "grant" }` when no hook is registered.
   * Fail-closed on timeout / handler error / RPC failure per architect
   * plan §3.4.
   */
  private dispatchAuthorizeDispatchHook(
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
      manifest?.hooks?.task_authorize_dispatch?.timeout_ms ??
      DEFAULT_APP_HOOK_TIMEOUT_MS;
    const taskId = ctx.taskId;

    const raw: Effect.Effect<DispatchAdmissionResult, Error> = remote
      ? this.runRemoteHookEffect({
          appId,
          definition: TaskAuthorizeDispatch,
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
      timeoutLogMessage: "task/authorizeDispatch timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "task/authorizeDispatch error",
      errorLogContext: { taskId, appId },
      onTimeout: () => ({
        decision: "deny" as const,
        reason: "task/authorizeDispatch timed out",
      }),
      onError: () => ({
        decision: "deny" as const,
        reason: "task/authorizeDispatch error",
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
