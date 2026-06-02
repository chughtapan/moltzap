import { Context } from "effect";
import type { Task, TaskId } from "../tasks.js";
import { TaskClosedError } from "../tasks.js";
import type { ConversationId, MessageId } from "../conversations.js";
import {
  ConversationNotFoundError,
  ConversationArchivedError,
  NotAParticipantError,
} from "../conversations.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Composite capability for `MessageService.send`.
 *
 * One tag carrying one payload shape. The handler obtains the value
 * via `provideServiceEffect`; the service body destructures the
 * carried proof rows directly. TM authority to send into a task is
 * proved at obtain time via app-ownership of the calling WS
 * connection, so there is no per-variant bypass flag on the payload.
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
)<MessageSendPermission, MessageSendPermissionValue>() {
  static get errors() {
    return [
      ConversationNotFoundError,
      NotAParticipantError,
      ConversationArchivedError,
      TaskClosedError,
    ] as const;
  }
}

/**
 * Input shape consumed by the dispatch-time smart constructor. The
 * handler passes the raw `MessagesSend` params + the authenticated
 * `ctx.agentId`; the constructor handles the conversation lookup,
 * participant check, task-active refinement, reply-target check, and
 * returns the populated value.
 */
export interface ObtainMessageSendPermissionInput {
  /**
   * Optional defensive cross-check. When supplied (e.g. by the
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
