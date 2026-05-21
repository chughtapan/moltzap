import { Context } from "effect";
import type { Task, TaskId } from "../tasks.js";
import type { ConversationId, MessageId } from "../conversations.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Composite capability for `MessageService.send` — Architect Decision A
 * in plan #606.
 *
 * One tag carrying one payload shape. The handler obtains the value
 * via `provideServiceEffect`; the service body destructures the
 * carried proof rows directly.
 *
 * Earlier revisions of this surface modelled a three-arm discriminated
 * union (`forParticipantOnActiveTask | forTmBypass |
 * forTmBypassWithReply`) so the TM could bypass the
 * `refineTaskActive` gate when sending into a `failed` task. The
 * downstream `MessageService.sendInsert` never discriminated the
 * variants, no production caller exercised the failed-task window,
 * and the TM gate is now proved at obtain time via app-ownership of
 * the calling WS connection rather than a per-variant bypass flag.
 * The bypass mechanism was removed in the #673 follow-up.
 */
export interface MessageSendPermissionValue {
  readonly task: Task;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;

  /**
   * Reply-target proof. Tagged union — `ValidReply` carries the
   * verified `replyToId`; `NoReply` is the absence sentinel. Kept as
   * a sub-union because the verification step is a separate concern
   * from message-send admission.
   */
  readonly replyTarget:
    | { readonly _tag: "ValidReply"; readonly replyToId: MessageId }
    | { readonly _tag: "NoReply" };
}

export class MessageSendPermission extends Context.Tag(
  "@moltzap/protocol/MessageSendPermission",
)<MessageSendPermission, MessageSendPermissionValue>() {}

/**
 * Input shape consumed by the dispatch-time smart constructor. The
 * handler passes the raw `MessagesSend` params + the authenticated
 * `ctx.agentId`; the constructor handles the conversation lookup,
 * participant check, task-active refinement, reply-target check, and
 * returns the populated value.
 */
export interface ObtainMessageSendPermissionInput {
  /**
   * Optional defensive cross-check. When supplied (e.g. by D1's
   * `TaskConversation*` handlers whose wire shape names `taskId`
   * independently of the conversation), `obtainMessageSendPermission`
   * runs an `assertConvBelongsToTask` defense against the conv lookup.
   * `MessagesSend` omits the field; when omitted the obtain helper
   * uses `conv.task_id` directly.
   */
  readonly taskId?: TaskId;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly replyToId?: MessageId;
}
