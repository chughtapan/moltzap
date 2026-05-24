# protocol/task/capabilities

_`packages/protocol/src/task/capabilities`_

## Purpose

Public barrel for R-channel capability tag classes.

Tag classes + value types only. Obtain/refine helpers that depend on
server-side services live in `@moltzap/server-core/app/capabilities`.

## Public surface

### [`AgentExists`](./agent-exists.ts#L15)

_Class_

```ts
export class AgentExists extends Context.Tag("@moltzap/protocol/AgentExists")<
  AgentExists,
  AgentExistsValue
>() {}
```

### [`AgentExistsValue`](./agent-exists.ts#L10)

_Interface_

```ts
export interface AgentExistsValue {
  readonly agentId: AgentId;
  readonly ownerUserId: string | null;
}
```

Tier 2 capability — `agentId` resolves to a real, active `agents` row.

Value payload carries `ownerUserId` (nullable, since unclaimed agents
are valid existence proofs but have no owner).

### [`AgentInTaskParticipants`](./agent-in-task-participants.ts#L17)

_Class_

```ts
export class AgentInTaskParticipants extends Context.Tag(
  "@moltzap/protocol/AgentInTaskParticipants",
)<AgentInTaskParticipants, AgentInTaskParticipantsValue>() {}
```

### [`AgentInTaskParticipantsValue`](./agent-in-task-participants.ts#L12)

_Interface_

```ts
export interface AgentInTaskParticipantsValue {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}
```

Tier 2 capability — `agentId` is in `task_participants` for `taskId`.
Used by `TaskConversationAddParticipant` (D1's new handler) to prove
the agent being added to a conversation already participates in the
parent task — today's inline `task_participants` query becomes the
capability obtain.

### [`assertConversationInTaskMatches`](./assert-capability-matches-task.ts#L61)

_Function_

```ts
export const assertConversationInTaskMatches = (
  cap: ConversationInTaskValue,
  expectedTaskId: TaskId,
  expectedConversationId: ConversationId,
): Effect.Effect<void, ForbiddenError>
```

Verifies the capability's carried `(taskId, conversationId)` pair
equals the expected pair. Fails with `ForbiddenError` on the first
mismatch; runs both comparisons in one Effect for handler-side
symmetry with `assertTmAuthorityMatchesTask`.

### [`assertTaskReadAccessMatchesTask`](./assert-capability-matches-task.ts#L49)

_Function_

```ts
export const assertTaskReadAccessMatchesTask = (
  cap: TaskReadAccessValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError>
```

Verifies `cap.task.id === expectedTaskId` for `TaskReadAccess`. The
value shape mirrors `TmAuthorityValue`; a separate overload keeps the
type narrowed at the call site.

### [`assertTmAuthorityMatchesTask`](./assert-capability-matches-task.ts#L38)

_Function_

```ts
export const assertTmAuthorityMatchesTask = (
  cap: TmAuthorityValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError>
```

Verifies `cap.task.id === expectedTaskId`. Fails with
`ForbiddenError` when the handler obtained a capability for one task
but passed a different `taskId` argument to the service method.

### [`ContactPolicyAllowsReach`](./contact-policy-allows-reach.ts#L9)

_Class_

```ts
export class ContactPolicyAllowsReach extends Context.Tag(
  "@moltzap/protocol/ContactPolicyAllowsReach",
)<ContactPolicyAllowsReach, ContactPolicyAllowsReachValue>() {}
```

### [`ContactPolicyAllowsReachValue`](./contact-policy-allows-reach.ts#L4)

_Interface_

```ts
export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}
```

### [`ConversationCreateAuthorization`](./conversation-create-authorization.ts#L8)

_Class_

```ts
export class ConversationCreateAuthorization extends Context.Tag(
  "@moltzap/protocol/ConversationCreateAuthorization",
)<ConversationCreateAuthorization, ConversationCreateAuthorizationValue>() {}
```

### [`ConversationCreateAuthorizationValue`](./conversation-create-authorization.ts#L4)

_Interface_

```ts
export interface ConversationCreateAuthorizationValue {
  readonly ownerByAgentId: ReadonlyMap<AgentId, string | null>;
}
```

### [`ConversationInTask`](./conversation-in-task.ts#L18)

_Class_

```ts
export class ConversationInTask extends Context.Tag(
  "@moltzap/protocol/ConversationInTask",
)<ConversationInTask, ConversationInTaskValue>() {}
```

### [`ConversationInTaskValue`](./conversation-in-task.ts#L13)

_Interface_

```ts
export interface ConversationInTaskValue {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}
```

Tier 2 capability — proves `conversation.task_id === taskId`.

`assertCapabilityMatchesTask` (see `assert-capability-matches-task.ts`)
verifies the carried `taskId` matches the handler-input `taskId` at
call time — the one-line runtime check that catches "handler passed
a different taskId than the obtain proved".

### [`ConversationNotArchived`](./conversation-not-archived.ts#L19)

_Class_

```ts
export class ConversationNotArchived extends Context.Tag(
  "@moltzap/protocol/ConversationNotArchived",
)<ConversationNotArchived, ConversationNotArchivedValue>() {}
```

### [`ConversationNotArchivedValue`](./conversation-not-archived.ts#L15)

_Interface_

```ts
export interface ConversationNotArchivedValue {
  readonly conversationId: ConversationId;
}
```

Tier 4 refine-shape capability — `conversation.archived_at IS NULL`.

Refine-shape: takes the `archived_at` column read inline by the
caller. Folded into the composite `MessageSendPermission` value
for the MessagesSend path (every constructor verifies the
conversation is open).

### [`GroupCapacityForCreate`](./group-capacity-for-create.ts#L18)

_Class_

```ts
export class GroupCapacityForCreate extends Context.Tag(
  "@moltzap/protocol/GroupCapacityForCreate",
)<GroupCapacityForCreate, GroupCapacityForCreateValue>() {}
```

### [`GroupCapacityForCreateValue`](./group-capacity-for-create.ts#L13)

_Interface_

```ts
export interface GroupCapacityForCreateValue {
  readonly creatorAgentId: AgentId;
  readonly invitedAgentIds: readonly AgentId[];
}
```

Tier 4 capability — admitting the proposed `invitedAgentIds` to a new
task respects policy limits on group capacity. Required by
`TaskRequest` ONLY when `invitedAgentIds.length > 1`.

Value payload carries `(creatorAgentId, invitedAgentIds)` to match
the obtain-time argument set; service methods consuming the capability
verify the count matches handler input.

### [`MessageSendPermission`](./message-send-permission.ts#L40)

_Class_

```ts
export class MessageSendPermission extends Context.Tag(
  "@moltzap/protocol/MessageSendPermission",
)<MessageSendPermission, MessageSendPermissionValue>() {}
```

### [`MessageSendPermissionValue`](./message-send-permission.ts#L24)

_Interface_

```ts
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
```

Composite capability for `MessageService.send` — Architect Decision A
in plan #606.

One tag carrying one payload shape. The handler obtains the value
via `provideServiceEffect`; the service body destructures the
carried proof rows directly.

Earlier revisions of this surface modelled a three-arm discriminated
union (`forParticipantOnActiveTask | forTmBypass |
forTmBypassWithReply`) so the TM could bypass the
`refineTaskActive` gate when sending into a `failed` task. The
downstream `MessageService.sendInsert` never discriminated the
variants, no production caller exercised the failed-task window,
and the TM gate is now proved at obtain time via app-ownership of
the calling WS connection rather than a per-variant bypass flag.
The bypass mechanism was removed in the #673 follow-up.

### [`noReplyTarget`](./reply-target.ts#L40)

_Function_

```ts
export const noReplyTarget = (): NoReplyTargetValue
```

Synchronous constructor — no runtime check needed.

### [`NoReplyTarget`](./reply-target.ts#L35)

_Class_

```ts
export class NoReplyTarget extends Context.Tag(
  "@moltzap/protocol/NoReplyTarget",
)<NoReplyTarget, NoReplyTargetValue>() {}
```

### [`NoReplyTargetValue`](./reply-target.ts#L31)

_Interface_

```ts
export interface NoReplyTargetValue {
  readonly _tag: "NoReplyTarget";
}
```

Zero-payload tag: declared when the send has no reply target.

### [`ObtainConversationCreateAuthorizationInput`](./conversation-create-authorization.ts#L12)

_Interface_

```ts
export interface ObtainConversationCreateAuthorizationInput {
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
}
```

### [`ObtainMessageSendPermissionInput`](./message-send-permission.ts#L51)

_Interface_

```ts
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
```

Input shape consumed by the dispatch-time smart constructor. The
handler passes the raw `MessagesSend` params + the authenticated
`ctx.agentId`; the constructor handles the conversation lookup,
participant check, task-active refinement, reply-target check, and
returns the populated value.

### [`refineConversationNotArchived`](./conversation-not-archived.ts#L28)

_Function_

```ts
export const refineConversationNotArchived = (
  conversationId: ConversationId,
  archivedAt: Date | null,
): Effect.Effect<ConversationNotArchivedValue, ConversationArchivedError>
```

Refine constructor. Fails with `ConversationArchivedError` when
`archivedAt` is non-null. Consumed by `obtainMessageSendPermission`
after the conversation projection lookup.

### [`refineTaskActive`](./task-active.ts#L39)

_Function_

```ts
export const refineTaskActive = (
  taskId: TaskId,
  status: TaskStatus,
): Effect.Effect<TaskActiveValue, TaskClosedError>
```

Refine constructor. Fails with `TaskClosedError` when status is
`closed` / `failed`. Consumed by `obtainMessageSendPermission` on
the non-TM-bypass branch.

### [`TaskActive`](./task-active.ts#L29)

_Class_

```ts
export class TaskActive extends Context.Tag("@moltzap/protocol/TaskActive")<
  TaskActive,
  TaskActiveValue
>() {}
```

### [`TaskActiveValue`](./task-active.ts#L24)

_Interface_

```ts
export interface TaskActiveValue {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
}
```

Tier 4 refine-shape capability — task status accepts messages
(NOT `closed` / `failed`).

Refine-shape: takes a `SendConversationRow` already fetched by
`MessageService.readSendConversation` and validates the `task_status`
column inline. No DB call. Consumed by the composite
`MessageSendPermission.forParticipantOnActiveTask` obtain helper.

The TM-bypass branch is NOT a `TaskActive` proof — it's modeled in
the composite `MessageSendPermission.forTmBypass` constructor instead.

## Staleness window

`TaskActive` is a liveness proof — `tasks.status` can transition
`active → closed` between obtain and use. The refine helper is safe
to call inside the same transaction that reads the task row;
cross-transaction reuse is a defect (re-obtain by re-reading the
column).

### [`TaskReadAccess`](./task-read-access.ts#L21)

_Class_

```ts
export class TaskReadAccess extends Context.Tag(
  "@moltzap/protocol/TaskReadAccess",
)<TaskReadAccess, TaskReadAccessValue>() {}
```

### [`TaskReadAccessValue`](./task-read-access.ts#L16)

_Interface_

```ts
export interface TaskReadAccessValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}
```

Tier 1 capability — caller has read access to `task` (initiator OR
admitted `task_participant`).

Value payload carries the `task` row already fetched by today's
`TaskService.loadTaskWithReadAccess` check; consumers reuse the payload.

Consumed by the `task.service.ts` public methods (`get`, `getMessages`,
`getMessagesSince`) via the R-channel; handlers wire the value with
`Effect.provideServiceEffect(TaskReadAccess, obtainTaskReadAccess(...))`.

### [`TmAuthority`](./tm-authority.ts#L18)

_Class_

```ts
export class TmAuthority extends Context.Tag("@moltzap/protocol/TmAuthority")<
  TmAuthority,
  TmAuthorityValue
>() {}
```

### [`TmAuthorityValue`](./tm-authority.ts#L14)

_Interface_

```ts
export interface TmAuthorityValue {
  readonly task: Task;
}
```

Capability — caller's WS connection IS the registered remote-app
connection for `task.appId`. The obtain helper resolves the proof
via `AppHost.isAppConnection(task.appId, callerConnId)`; the bind
is stable across requests on the same WS and invalidated by the
connection's Scope finalizer.

Value payload carries the `task` row already fetched by the obtain
helper so consumers don't re-query.

### [`ValidReplyTarget`](./reply-target.ts#L26)

_Class_

```ts
export class ValidReplyTarget extends Context.Tag(
  "@moltzap/protocol/ValidReplyTarget",
)<ValidReplyTarget, ValidReplyTargetValue>() {}
```

### [`ValidReplyTargetValue`](./reply-target.ts#L21)

_Interface_

```ts
export interface ValidReplyTargetValue {
  readonly conversationId: ConversationId;
  readonly replyToId: MessageId;
}
```

Tier 4 capabilities — reply-target presence proof.

One of `ValidReplyTarget` / `NoReplyTarget` is required by
`MessagesSend`. The two tags model the input-shape branch:
`input.replyToId !== undefined` obtains `ValidReplyTarget` (which
verifies the referenced message exists in the target conversation);
`input.replyToId === undefined` obtains the zero-payload
`NoReplyTarget` constructor.

Per Architect Decision A, these two tags are FOLDED into the
composite `MessageSendPermission` value (every constructor variant
carries one of the reply-target proofs) — they're not provided as
separate R-channel tags at the MessagesSend handler. They remain
standalone tags so D1 / future handlers can require them
independently if/when needed.

## Files

- `agent-exists.ts`
- `agent-in-task-participants.ts`
- `assert-capability-matches-task.ts`
- `contact-policy-allows-reach.ts`
- `conversation-create-authorization.ts`
- `conversation-in-task.ts`
- `conversation-not-archived.ts`
- `group-capacity-for-create.ts`
- `message-send-permission.ts`
- `reply-target.ts`
- `task-active.ts`
- `task-read-access.ts`
- `tm-authority.ts`
