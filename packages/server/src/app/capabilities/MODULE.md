# server-core/app/capabilities

_`packages/server/src/app/capabilities`_

## Purpose

R-channel capability tokens for privileged service methods.
See `README.md` in this directory for the pattern overview and
`packages/server/src/app/capability-providers.ts` (file-level
JSDoc) for the migration recipe.

## Public surface

### [`obtainAddParticipantPermission`](./add-participant-permission.ts#L28)

_Function_

```ts
  input: ObtainAddParticipantPermissionInput,
): Effect.Effect<
  AddParticipantPermissionValue,
  ConversationServiceError,
  ConversationServiceTag | ParticipantServiceTag
>
```

Smart constructor. Runs the four gates in their pre-Spec-E order;
carries the resolved `targetOwnerUserId` so the service body and
any downstream auditing can read it without an extra round-trip.

**Fails with:**

- `ForbiddenError` — the requester lacks add-participant authority on the conversation
- `NotFoundError` — the target `agents` row is missing
- `NotInContactsError` — contact policy rejects the requester→target reach
- `ConversationFullError` — the conversation already has the maximum participants
- `InvalidParamsError` — the conversation is a DM (DMs cannot grow participants)

### [`obtainAgentExists`](./agent-exists.ts#L18)

_Function_

```ts
  agentId: AgentId,
): Effect.Effect<AgentExistsValue, NotFoundError, ParticipantServiceTag>
```

Smart constructor. Delegates to `ParticipantService.assertAgentExists`
(already public on the service class pre-Spec-E).

`SqlError` from the underlying select is caught defectively inside
the service helper.

**Fails with:**

- `NotFoundError` — the `agents` row is absent

### [`obtainAgentInTaskParticipants`](./agent-in-task-participants.ts#L23)

_Function_

```ts
  taskId: TaskId,
  agentId: AgentId,
): Effect.Effect<
  AgentInTaskParticipantsValue,
  ForbiddenError,
  TaskServiceTag
>
```

Smart constructor. Delegates to
`TaskService.assertAgentInTaskParticipants` (NEW in Phase 1 per
Decision B / Option A) so the underlying `task_participants` query
stays in the service layer.

`SqlError` is caught defectively at the service-helper boundary.

**Fails with:**

- `ForbiddenError` — the agent is not in `task_participants` for the given task

### [`obtainContactPolicyForAdd`](./contact-policy-allows-reach.ts#L72)

_Function_

```ts
  targetAgentId: AgentId,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ConversationServiceError,
  ConversationServiceTag
>
```

Smart constructor for `TaskConversationAddParticipant` (D1) /
`ConversationAddParticipant` flows.

Wraps the existing named service gate
`ConversationService.assertAddParticipantContactPolicy` — Phase 1
narrows the gate's signature to `(requesterAgentId, targetAgentId,
targetOwnerUserId)` so the obtain helper delegates without
synthesizing an `AddParticipantOptions` shim with a placeholder
`conversationId`. Single source of truth: the service caller inside
`addParticipantEffect` and the obtain helper both call this method.

**Fails with:**

- `NotInContactsError` — caller's contact policy rejects the target
- `NotFoundError` — a referenced `agents` row is missing
- `ForbiddenError` — generic policy denies the path
- `InvalidParamsError` — shape mismatch

### [`obtainContactPolicyForCreate`](./contact-policy-allows-reach.ts#L31)

_Function_

```ts
  creatorAgentId: AgentId,
  targetAgentIds: readonly AgentId[],
  type: "dm" | "group" = "group",
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ConversationServiceError,
  ConversationServiceTag
>
```

Smart constructor for `TaskCreate` / `ConversationCreate` flows.

Wraps (does not re-implement) the existing named service gate
`ConversationService.assertContactPolicyForCreate` — Phase 1
narrows the gate's signature to `(creatorAgentId, targetAgentIds,
pathType, ownerByAgentId)` so the obtain helper delegates without a
`mintTask: Effect.never as never` synthesis shim. Single source of
truth for the create-side contact-policy fan-out: the service caller
inside `createConversationEffect` and the obtain helper both call
this method. `SqlError` from the underlying contact-edge lookups is
caught defectively inside the service helpers.

**Fails with:**

- `NotInContactsError` — caller's contact policy rejects a target
- `NotFoundError` — a referenced `agents` row is missing
- `ForbiddenError` — generic policy denies the path
- `InvalidParamsError` — DM-arity / shape mismatch

### [`obtainConversationCreateAuthorization`](./conversation-create-authorization.ts#L34)

_Function_

```ts
  input: ObtainConversationCreateAuthorizationInput,
): Effect.Effect<
  ConversationCreateAuthorizationValue,
  ConversationServiceError,
  ConversationServiceTag
>
```

Smart constructor for `ConversationsCreate`. Reaches into
`ConversationService` via the service Tag to:
 1. Load `ownerByAgentId` via `loadAgentOwners` (NotFound if any
    agent missing).
 2. Check for an existing DM via `existingDmForCreate` (DM-arity
    invariants enforced inside the helper). Returns `ExistingDm`
    when found; this is the short-circuit branch.
 3. Otherwise: run the contact-policy and group-capacity gates and
    return `PermittedToCreate { ownerByAgentId }`.

**Fails with:**

- `NotFoundError` — a referenced `agents` row is missing
- `InvalidParamsError` — DM-arity invariants are violated
- `NotInContactsError` — caller's contact policy rejects a target
- `ForbiddenError` — policy denies the create
- `ConversationFullError` — participant count exceeds the policy limit

### [`obtainConversationInTask`](./conversation-in-task.ts#L23)

_Function_

```ts
  taskId: TaskId,
  conversationId: ConversationId,
): Effect.Effect<ConversationInTaskValue, TaskServiceError, TaskServiceTag>
```

Smart constructor. Phase 1 promotes
`TaskService.assertConversationInTask` to `@internal` exported per
Decision B (Option A); this helper consumes it through the service
Tag. `SqlError` from the underlying lookup is caught defectively
inside the service helper.

**Fails with:**

- `ForbiddenError` — the conversation does not belong to the specified task
- `NotFoundError` — the conversation does not exist

### [`obtainConversationParticipantAccess`](./conversation-participant-access.ts#L25)

_Function_

```ts
  conversationId: ConversationId,
  caller: AgentId,
): Effect.Effect<
  ConversationParticipantAccessValue,
  ForbiddenError,
  ConversationServiceTag
>
```

Smart constructor. Delegates to
`ConversationService.assertConversationParticipant` (already public
on the service class pre-Spec-E). The `SqlError` from the
underlying `conversation_participants` lookup is caught defectively
inside the service helper, so it does NOT appear in E.

**Fails with:**

- `ForbiddenError` — caller is not a participant in this conversation

### [`obtainGroupCapacityForCreate`](./group-capacity-for-create.ts#L22)

_Function_

```ts
  creatorAgentId: AgentId,
  invitedAgentIds: readonly AgentId[],
): Effect.Effect<
  GroupCapacityForCreateValue,
  ConversationFullError,
  ConversationServiceTag
>
```

Smart constructor. Phase 1 promotes
`ConversationService.assertGroupCapacityForCreate` to `@internal`
exported per Decision B / Option A and narrows its signature to
`(pathType, targetAgentIds)` so the obtain helper consumes it
without a `mintTask: Effect.never as never` synthesis shim. Pure
capacity check; no DB read; no `SqlError` in E.

**Fails with:**

- `ConversationFullError` — proposed participant count exceeds the policy limit

### [`obtainMessageSendPermission`](./message-send-permission.ts#L157)

_Function_

```ts
  input: ObtainMessageSendPermissionInput,
): Effect.Effect<
  MessageSendPermissionValue,
  | ForbiddenError
  | NotFoundError
  | ConversationArchivedError
  | TaskClosedError
  | TaskServiceError,
  TaskServiceTag | ConversationServiceTag | MessageServiceTag
>
```

### [`obtainTaskReadAccess`](./task-read-access.ts#L21)

_Function_

```ts
  taskId: TaskId,
  caller: AgentId,
): Effect.Effect<TaskReadAccessValue, TaskServiceError, TaskServiceTag>
```

Smart constructor. Delegates to `TaskService.loadTaskWithReadAccess`
so the SQL lookup + initiator-or-participant branch is unchanged
from pre-Spec-E.

**Fails with:**

- `ForbiddenError` — caller is neither initiator nor admitted participant
- `NotFoundError` — the task does not exist

### [`obtainTmAuthority`](./tm-authority.ts#L25)

_Function_

```ts
  taskId: TaskId,
  caller: AgentId,
): Effect.Effect<TmAuthorityValue, TaskServiceError, TaskServiceTag>
```

Smart constructor: wraps today's runtime check exactly once per
request. Body delegates to `TaskService.loadTaskAsTmAuthority`, which
still performs the same SQL lookup + status branch + endpoint
equality check it did pre-Spec-E. `SqlError` is caught defectively
by `fetchTask`. The error channel is carried as the full
`TaskServiceError` union so impl-staff cannot accidentally
over-narrow when the underlying helper widens.

**Fails with:**

- `ForbiddenError` — the caller is not the TM, or the task is closed/failed
- `NotFoundError` — the task does not exist

### [`obtainValidReplyTarget`](./reply-target.ts#L35)

_Function_

```ts
  conversationId: ConversationId,
  replyToId: MessageId,
): Effect.Effect<ValidReplyTargetValue, NotFoundError, MessageServiceTag>
```

Smart constructor. Delegates to `MessageService.assertReplyTarget`
(Phase 1 promotes the helper to `@internal` exported per Decision B
/ Option A). `SqlError` from the underlying select is caught
defectively inside the service helper.

R channel includes `MessageServiceTag` because the obtain helper
dereferences the (Phase-1-promoted-to-`@internal`)
`MessageService.assertReplyTarget` method through the service Tag.

**Fails with:**

- `NotFoundError` — `replyToId` does not resolve to a message in `conversationId`

## Files

- `add-participant-permission.ts`
- `agent-exists.ts`
- `agent-in-task-participants.ts`
- `contact-policy-allows-reach.ts`
- `conversation-create-authorization.ts`
- `conversation-in-task.ts`
- `conversation-participant-access.ts`
- `group-capacity-for-create.ts`
- `message-send-permission.ts`
- `reply-target.ts`
- `task-read-access.ts`
- `tm-authority.ts`
