import { Context } from "effect";
import type { Task, TaskId } from "../tasks.js";
import type { ConversationId, MessageId } from "../conversations.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Composite capability for `MessageService.send` — Architect Decision A
 * in plan #606.
 *
 * ## Why a composite (and not the spec's union-of-tags shape)?
 *
 * Effect's R channel uses union types to ENCODE the set of required
 * services — `Effect&lt;A, E, T1 | T2>` requires BOTH `T1` AND `T2` to be
 * provided before the effect is runnable. There is no native "exactly
 * one of" semantics in `provideServiceEffect`. The composite shape —
 * one tag with three constructors — preserves the "exactly one path"
 * authorization while keeping a single R-channel entry.
 *
 * ## Shape
 *
 * `MessageSendPermission` is a single `Context.Tag` whose value is a
 * discriminated union over the three legal authorization paths. The
 * handler picks the right constructor at `provideServiceEffect` time;
 * the service body destructures the union via `_tag` and uses the
 * carried proof rows.
 *
 * - `forParticipantOnActiveTask` — caller is a conversation participant
 *   on an OPEN task; optional `replyToId` carried inside the variant.
 * - `forTmBypass` — caller IS the TM (bypasses the "task is open" gate);
 *   no reply target.
 * - `forTmBypassWithReply` — TM bypass + the reply target was verified.
 */
export type MessageSendPermissionValue =
  | {
      readonly _tag: "forParticipantOnActiveTask";
      readonly task: Task;
      readonly conversationId: ConversationId;
      readonly senderAgentId: AgentId;
      readonly replyTarget:
        | { readonly _tag: "ValidReply"; readonly replyToId: MessageId }
        | { readonly _tag: "NoReply" };
    }
  | {
      readonly _tag: "forTmBypass";
      readonly task: Task;
      readonly conversationId: ConversationId;
      readonly senderAgentId: AgentId;
      readonly replyTarget: { readonly _tag: "NoReply" };
    }
  | {
      readonly _tag: "forTmBypassWithReply";
      readonly task: Task;
      readonly conversationId: ConversationId;
      readonly senderAgentId: AgentId;
      readonly replyTarget: {
        readonly _tag: "ValidReply";
        readonly replyToId: MessageId;
      };
    };

export class MessageSendPermission extends Context.Tag(
  "@moltzap/protocol/MessageSendPermission",
)<MessageSendPermission, MessageSendPermissionValue>() {}

/**
 * Input shape consumed by the dispatch-time smart constructor. The
 * handler passes the raw `MessagesSend` params + the authenticated
 * `ctx.agentId` + the calling WS connection id; the constructor
 * handles the conversation lookup, participant check, reply-target
 * check, TM-bypass discrimination (proved via app-ownership of the
 * calling connection against `task.appId`), and returns the populated
 * discriminated union.
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

  /**
   * Calling WebSocket connection id. The TM-bypass branch is taken
   * iff `AppHost.isAppConnection(task.appId, callerConnId)`.
   */
  readonly callerConnId: string;
  readonly replyToId?: MessageId;
}
