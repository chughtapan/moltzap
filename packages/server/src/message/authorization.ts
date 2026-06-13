import { Effect } from "effect";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { AgentId, AppId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import {
  callAppRpc,
  type AppHost,
  type AppRegistration,
  wrapHookEffectWithEnvelope,
} from "#identity/apps";

export type MessageAuthorizeContext = ParamsOf<typeof MessagesAuthorize>;

export type MessageAuthorizeResult =
  | {
      readonly decision: "Forward";
      readonly recipients: ReadonlyArray<AgentId>;
    }
  | { readonly decision: "Block"; readonly reason?: string };

export interface MessageAuthorizationConversations {
  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]>;
}

export class MessageAuthorizationService {
  constructor(
    private readonly apps: AppHost,
    private readonly conversations: MessageAuthorizationConversations,
  ) {}

  authorize(
    appId: AppId,
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const entry = this.apps.lookupApp(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "Block",
        reason: "app_unreachable",
      });
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
    }
  }

  private forwardAllExceptSender(
    ctx: MessageAuthorizeContext,
  ): Effect.Effect<MessageAuthorizeResult, never> {
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
  ): Effect.Effect<MessageAuthorizeResult, never> {
    const taskId = ctx.taskId;
    return wrapHookEffectWithEnvelope({
      raw: callAppRpc(entry, {
        definition: MessagesAuthorize,
        params: this.messageAuthorizeParamsForWire(ctx),
      }).pipe(Effect.map((envelope) => envelope.verdict)),
      timeoutMs,
      timeoutLogMessage: "app/message/authorize timed out",
      timeoutLogContext: { taskId, appId, timeoutMs },
      errorLogMessage: "app/message/authorize error",
      errorLogContext: { taskId, appId },
      onTimeout: () => ({
        decision: "Block",
        reason: "app_unreachable",
      }),
      onError: () => ({
        decision: "Block",
        reason: "app_unreachable",
      }),
    });
  }

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
}
