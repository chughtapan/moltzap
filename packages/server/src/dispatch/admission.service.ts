import { Data, Effect, Option } from "effect";
import type { SqlError } from "@effect/sql/SqlError";
import {
  dispatchAuthorize,
  type DispatchId,
  type LeaseId,
} from "@moltzap/protocol/message/dispatch";
import type { MessageParts } from "@moltzap/protocol/message";
import type { AgentId, AppId, UserId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { TaskId } from "@moltzap/protocol/task";
import type { NetworkSendServiceTag } from "#network";
import {
  callAppRpc,
  type AppEndpointRegistry,
  wrapHookEffectWithEnvelope,
} from "#identity/apps";
import { type Db, catchSqlErrorAsDefect, takeFirstOption } from "#db";
import type {
  LeaseRegistry,
  LeaseVerdict,
  ModeratorBoundLeaseBinding,
} from "./lease-registry.js";

/** Represents dispatch authorize context values. */
export type DispatchAuthorizeContext = ParamsOf<typeof dispatchAuthorize>;

interface AppBoundConversationLookup {
  readonly _tag: "AppBound";
  readonly taskId: TaskId;
  readonly appId: AppId;
}

/**
 * Dispatch admission is only defined for app-bound conversations. The
 * success type has no non-app-bound arm, so downstream lease minting
 * cannot accidentally handle one as a lease binding.
 * @param db Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @returns The lookup app bound for conversation result.
 */
function lookupAppBoundForConversation(
  db: Db,
  conversationId: ConversationId,
): Effect.Effect<AppBoundConversationLookup> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("conversations")
          .innerJoin("tasks", "tasks.id", "conversations.task_id")
          .select(["tasks.id as task_id", "tasks.app_id"])
          .where("conversations.id", "=", conversationId)
          .where("tasks.app_id", "is not", null)
          .limit(1),
      );
      if (Option.isNone(rowOpt) || rowOpt.value.app_id === null) {
        return yield* Effect.dieMessage(
          `agent/dispatch/request requires an app-bound conversation: ${conversationId}`,
        );
      }
      const lookup: AppBoundConversationLookup = {
        _tag: "AppBound",
        taskId: rowOpt.value.task_id,
        appId: rowOpt.value.app_id,
      };
      return lookup;
    }).pipe(Effect.withSpan("lookupAppBoundForConversation")),
  );
}

/** Represents the result of dispatch admission. */
export type DispatchAdmissionResult =
  | {
      readonly decision: "grant";
      readonly leaseId?: LeaseId;
      readonly leaseTimeoutMs?: number;
      readonly dispatchMessageId?: MessageId;
    }
  | { readonly decision: "deny"; readonly reason?: string }
  | { readonly decision: "hold"; readonly reason?: string };

type PendingDispatchMessage = Readonly<{
  messageId: MessageId;
  conversationId: ConversationId;
  senderAgentId: AgentId;
  createdAt: string;
  receivedAt: string;
  parts?: MessageParts;
}>;

/** Describes enqueue dispatch request args. */
export interface EnqueueDispatchRequestArgs {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: MessageParts;
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly pending?: readonly PendingDispatchMessage[];
}

/** Describes dispatch admission conversations. */
export interface DispatchAdmissionConversations {
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<unknown, unknown, NetworkSendServiceTag>;
}

interface DispatchRoundTripParams {
  readonly conversationId: ConversationId;
  readonly recipientAgentId: AgentId;
  readonly messageId: MessageId;
  readonly senderAgentId: AgentId;
  readonly parts?: MessageParts;
  readonly attempt?: number;
  readonly receivedAt?: string;
  readonly pending?: readonly PendingDispatchMessage[];
}

class DispatchAppUnavailableError extends Data.TaggedError(
  "DispatchAppUnavailableError",
)<{
  readonly appId: AppId;
  readonly conversationId: ConversationId;
}> {
  override get message(): string {
    return `agent/dispatch/request cannot mint a moderator-bound lease because app ${this.appId} is unavailable for conversation ${this.conversationId}`;
  }
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
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/** Implements dispatch admission service. */
export class DispatchAdmissionService {
  private readonly db: Db;
  private readonly apps: AppEndpointRegistry;
  private readonly registry: LeaseRegistry;
  private readonly conversations: DispatchAdmissionConversations;

  constructor(
    db: Db,
    apps: AppEndpointRegistry,
    registry: LeaseRegistry,
    conversations: DispatchAdmissionConversations,
  ) {
    this.db = db;
    this.apps = apps;
    this.registry = registry;
    this.conversations = conversations;
  }

  enqueue(
    args: EnqueueDispatchRequestArgs,
  ): Effect.Effect<
    { readonly leaseId: LeaseId; readonly dispatchId: DispatchId },
    never,
    NetworkSendServiceTag
  > {
    return catchSqlErrorAsDefect(this.enqueueEffect(args));
  }

  private enqueueEffect(
    args: EnqueueDispatchRequestArgs,
  ): Effect.Effect<
    { readonly leaseId: LeaseId; readonly dispatchId: DispatchId },
    SqlError,
    NetworkSendServiceTag
  > {
    return Effect.gen(this, function* (this: DispatchAdmissionService) {
      const lookup = yield* lookupAppBoundForConversation(
        this.db,
        args.conversationId,
      );
      const binding = yield* this.dispatchLeaseBindingForLookup(args, lookup);
      const minted = yield* this.registry.mint(binding);

      yield* this.attachDispatchRoundTripFiber(minted.leaseId, lookup, {
        conversationId: args.conversationId,
        recipientAgentId: args.recipientAgentId,
        messageId: args.messageId,
        senderAgentId: args.senderAgentId,
        parts: args.parts,
        attempt: args.attempt,
        receivedAt: args.receivedAt,
        pending: args.pending,
      });
      return minted;
    });
  }

  private dispatchLeaseBindingForLookup(
    args: EnqueueDispatchRequestArgs,
    lookup: AppBoundConversationLookup,
  ): Effect.Effect<ModeratorBoundLeaseBinding> {
    const entry = this.apps.lookupApp(lookup.appId);
    if (entry === undefined) {
      return Effect.die(
        new DispatchAppUnavailableError({
          appId: lookup.appId,
          conversationId: args.conversationId,
        }),
      );
    }

    return Effect.succeed({
      _tag: "ModeratorBound",
      recipientAgentId: args.recipientAgentId,
      recipientConnectionId: args.recipientConnectionId,
      conversationId: args.conversationId,
      appId: lookup.appId,
      taskId: lookup.taskId,
      moderatorConnectionId: entry.endpoint.connId,
    });
  }

  private attachDispatchRoundTripFiber(
    leaseId: LeaseId,
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    return Effect.gen(this, function* (this: DispatchAdmissionService) {
      const fiber = yield* Effect.forkDaemon(
        this.runForkedDispatchRoundTrip(leaseId, lookup, params),
      );
      yield* this.registry.attachRoundTripFiber(leaseId, fiber);
    });
  }

  private runForkedDispatchRoundTrip(
    leaseId: LeaseId,
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    return catchSqlErrorAsDefect(
      this.runAppBoundDispatchRoundTrip(leaseId, lookup, params),
    );
  }

  private runAppBoundDispatchRoundTrip(
    leaseId: LeaseId,
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, SqlError, NetworkSendServiceTag> {
    if (this.apps.lookupApp(lookup.appId) === undefined) {
      return this.resolveLease(leaseId, {
        _tag: "deny",
        reason: "app_unavailable",
      });
    }

    return Effect.gen(this, function* (this: DispatchAdmissionService) {
      const ctx = yield* this.dispatchAuthorizeContext(lookup, params);
      const verdict = yield* this.dispatchAuthorize(lookup.appId, ctx);
      yield* this.resolveLease(leaseId, dispatchVerdictToLeaseVerdict(verdict));
      yield* this.removeDeniedParticipant(verdict, params);
    });
  }

  private dispatchAuthorizeContext(
    lookup: AppBoundConversationLookup,
    params: DispatchRoundTripParams,
  ): Effect.Effect<DispatchAuthorizeContext, SqlError> {
    return Effect.gen(this, function* (this: DispatchAdmissionService) {
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

  private resolveLease(
    leaseId: LeaseId,
    verdict: LeaseVerdict,
  ): Effect.Effect<void> {
    return this.registry.resolve(leaseId, verdict).pipe(Effect.ignore);
  }

  private removeDeniedParticipant(
    verdict: DispatchAdmissionResult,
    params: DispatchRoundTripParams,
  ): Effect.Effect<void, never, NetworkSendServiceTag> {
    if (verdict.decision !== "deny") {
      return Effect.void;
    }
    return this.conversations
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

  private dispatchAuthorize(
    appId: AppId,
    ctx: DispatchAuthorizeContext,
  ): Effect.Effect<DispatchAdmissionResult> {
    const entry = this.apps.lookupApp(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "deny",
        reason: "app_unavailable",
      });
    }
    const policy = entry.manifest.hooks.dispatch_authorize;
    switch (policy.kind) {
      case "grant":
        return Effect.succeed({ decision: "grant" });
      case "deny":
        return Effect.succeed({
          decision: "deny",
          reason: policy.reason,
        });
      case "hook": {
        const taskId = ctx.taskId;
        const timeoutMs = policy.timeoutMs;
        return wrapHookEffectWithEnvelope({
          raw: callAppRpc(entry, {
            definition: dispatchAuthorize,
            params: this.dispatchAuthorizeParamsForWire(ctx),
          }).pipe(Effect.map((envelope) => envelope.admission)),
          timeoutMs,
          timeoutLogMessage: "app/dispatch/authorize timed out",
          timeoutLogContext: { taskId, appId, timeoutMs },
          errorLogMessage: "app/dispatch/authorize error",
          errorLogContext: { taskId, appId },
          onTimeout: () => ({
            decision: "deny",
            reason: "timeout",
          }),
          onError: () => ({
            decision: "deny",
            reason: "app/dispatch/authorize error",
          }),
        });
      }
      default: {
        const exhaustive: never = policy;
        return exhaustive;
      }
    }
  }

  private dispatchAuthorizeParamsForWire(
    ctx: DispatchAuthorizeContext,
  ): ParamsOf<typeof dispatchAuthorize> {
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
}
