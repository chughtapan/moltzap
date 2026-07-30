import { Effect } from "effect";
import { messagesAuthorize } from "@moltzap/protocol/message";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { AgentId, AppId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import {
  callAppRpc,
  type AppEndpointRegistry,
  type AppRegistration,
  wrapHookEffectWithEnvelope,
} from "#identity/apps";

/** Represents message authorize context values. */
export type MessageAuthorizeContext = ParamsOf<typeof messagesAuthorize>;

/** Represents the result of message authorize. */
export type MessageAuthorizeResult =
  | {
      readonly decision: "Forward";
      readonly recipients: readonly AgentId[];
    }
  | { readonly decision: "Block"; readonly reason?: string };

/** Describes message authorization conversations. */
export interface MessageAuthorizationConversations {
  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]>;
}

/** Fail-closed verdict when the owning app cannot be reached. */
const APP_UNREACHABLE_BLOCK: MessageAuthorizeResult = {
  decision: "Block",
  reason: "app_unreachable",
};

/** Implements message authorization service. */
export class MessageAuthorizationService {
  private readonly apps: AppEndpointRegistry;
  private readonly conversations: MessageAuthorizationConversations;

  constructor(
    apps: AppEndpointRegistry,
    conversations: MessageAuthorizationConversations,
  ) {
    this.apps = apps;
    this.conversations = conversations;
  }

  authorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult> {
    const entry = this.apps.lookupApp(appId);
    if (entry === undefined) {
      return Effect.succeed(APP_UNREACHABLE_BLOCK);
    }

    const policy = entry.manifest.hooks.message_authorize;
    switch (policy.kind) {
      case "forwardAllExceptSender":
        return this.forwardAllExceptSender(ctx);
      case "deny":
        return Effect.succeed({
          decision: "Block",
          reason: policy.reason,
        });
      case "hook":
        return this.messageAuthorizeHook(entry, appId, ctx, policy.timeoutMs);
      default: {
        const exhaustive: never = policy;
        return exhaustive;
      }
    }
  }

  private forwardAllExceptSender(
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult> {
    return this.conversations.getParticipantAgentIds(ctx.conversationId).pipe(
      Effect.map(
        (participants): MessageAuthorizeResult => ({
          decision: "Forward",
          recipients: participants.filter(
            (id) => id !== ctx.message.senderAgentId,
          ),
        }),
      ),
      Effect.withSpan("message.authorization.forwardAllExceptSender"),
    );
  }

  private messageAuthorizeHook(
    entry: AppRegistration,
    appId: AppId,
    ctx: MessageAuthorizeContext,
    timeoutMs: number,
  ): Effect.Effect<MessageAuthorizeResult> {
    const taskId = ctx.taskId;
    return wrapHookEffectWithEnvelope({
      raw: callAppRpc(entry, {
        definition: messagesAuthorize,
        params: this.messageAuthorizeParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.verdict)),
      timeoutMs,
      timeoutLogMessage: "app/message/authorize timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "app/message/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => APP_UNREACHABLE_BLOCK,
      onError: () => APP_UNREACHABLE_BLOCK,
    });
  }

  private messageAuthorizeParamsForWire(
    ctx: MessageAuthorizeContext,
  ): ParamsOf<typeof messagesAuthorize> {
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
}
