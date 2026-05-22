# 12 — Task / TaskConversation family

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `task/*` + `task/conversation/*` RPC and notification surface for
task-bound conversations.

See `01-method-definition.md` for how `defineRpc` /
`defineNotification` build descriptors, and `05-notification-fanout.md`
for the encode side of notifications. Server-side handler structure
lives in `packages/server/src/task/handlers/`.

## Wire surface

### RPCs

| Wire name | Const | Authority |
|---|---|---|
| `task/create` | `TaskCreate` | any agent + contacts |
| `task/leave` | `TaskLeave` | self |
| `task/conversation/create` | `TaskConversationCreate` | TM |
| `task/conversation/list` | `TaskConversationList` | self |
| `task/conversation/archive` | `TaskConversationArchive` | TM |
| `task/conversation/unarchive` | `TaskConversationUnarchive` | TM |
| `task/conversation/participants/add` | `TaskConversationAddParticipant` | TM + admitted |
| `task/conversation/participants/remove` | `TaskConversationRemoveParticipant` | TM |

### Notifications

| Wire name | Const | Recipients (impl-staff target) |
|---|---|---|
| `task/conversation/created` | `TaskConversationCreatedNotificationDefinition` | initial `participants` list |
| `task/conversation/archived` | `TaskConversationArchivedNotificationDefinition` | post-mutation `conversation_participants` |
| `task/conversation/unarchived` | `TaskConversationUnarchivedNotificationDefinition` | post-mutation `conversation_participants` |
| `task/conversation/participants/added` | `TaskConversationParticipantsAddedNotificationDefinition` | post-mutation membership (newcomer included) |
| `task/conversation/participants/removed` | `TaskConversationParticipantsRemovedNotificationDefinition` | pre-mutation membership (removed agent still receives) |

`task/conversation/updated` is NOT defined — conversations are
set-at-create-time only (no in-place update flow).

## DEFAULT_APP_ID — server-bundled default app

```ts
export const DEFAULT_APP_ID = "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb" as AppId;
```

One app for every DM and every Group. Conversation kind (DM vs Group)
is a display-only label derived from participant cardinality where
needed; the server schema does not store it. Capacity is uniform 256
per conversation.

Tasks created with `DEFAULT_APP_ID` are unmoderated — there is no
remote app registered for them, so no connection passes the TM-authority
gate and TM-only RPCs are unreachable. Ordinary participants still send
messages via the AgentClient surface.

## TaskCreate flow

Data-flow contract (impl-staff translates to Effect+Kysely; this is
NOT normative pseudocode):

1. **Decode** — schema validates `appId` is a UUID-shaped branded string; `invitedAgentIds` is `AgentId[]` (may be empty); `initialConversation` is optional.
2. **Empty invited / self-included** — `invitedAgentIds` MAY be empty (creates a self-only task; the caller is the sole `task_participant`). `invitedAgentIds` MAY include the caller; the server normalizes the participant set as `{caller} ∪ invitedAgentIds` (set semantics) so the caller is never double-counted.
3. **Dedup hit (appId === DEFAULT_APP_ID only)** — the server queries `task_participants` for an existing task whose **set of admitted-OR-pending agent rows** (i.e. all rows under `task_participants(task_id)` regardless of `admittedAt IS NULL`) exactly equals `{caller} ∪ invitedAgentIds` AND whose `tasks.app_id = $appId`. If hit, returns the existing task (no conversation mint even when `initialConversation` is supplied — dedup is task-level, not conversation-level). Index expectation: the existing `task_participants` PRIMARY KEY `(task_id, agent_id)` covers the matching predicate; a supplementary `task_participants_agent_id` index (if present) accelerates the participant-set reverse lookup. Impl-staff confirms the index list against `core-schema.sql` before the SELECT lands.
4. **Mint** — if no dedup hit, the server inserts a new `tasks` row + one `task_participants` row per agent in `{caller} ∪ invitedAgentIds`, all inside one transaction.
5. **Atomic initial conversation** — when `initialConversation` is supplied the new task row is committed by `taskService.create` BEFORE `conversationService.create` opens its own transaction for the conversation insert. If the conversation insert fails the task row remains (the legacy `conversations/create` shape never offered cross-call atomicity either). Notifications enqueue AFTER each call returns: dual-emit fires only on the success path; failure rolls back ONLY the failing call. Implementers needing strict atomicity (one DB commit for task + first conversation) must extend `taskService.create` to nest the conversation insert inside its outer `transaction(...)` — out of scope for D1.
6. **Return** — `{ task, conversation: Conversation | null }`. `conversation` is non-null iff `initialConversation` was supplied AND the dedup query missed.

Dedup matches via `task_participants` (task-level): the helper
`taskService.findExistingTaskByParticipants(callerId, invitedAgentIds,
appId)` finds an extant task whose participant set is exactly
`{caller} ∪ invitedAgentIds`. The single-invitee case under
`DEFAULT_APP_ID` is the canonical "one DM per agent pair" rule.

## TaskLeave flow

Data-flow contract (impl-staff translates to Effect+Kysely; this is
NOT normative pseudocode):

1. **Decode** — schema validates `taskId`.
2. **Idempotency** — if the caller is not in `task_participants` for `taskId`, returns `{}` with no notifications. If `taskId` does not exist, returns `RpcServerError` with tag `not_found`.
3. **Transaction** — single `transaction(this.db, …)` boundary covering:
   - **Per-conversation membership snapshot** — SELECT the set of `conversation_id` values where `(conversation_id ∈ conversations WHERE task_id = $taskId) AND agent_id = $caller`. The snapshot is captured BEFORE deletion so the pre-mutation membership drives the `task/conversation/participants/removed` fan-out (so the leaver still receives their own removal notification).
   - **Bulk participant deletion** — one DELETE: `DELETE FROM conversation_participants WHERE agent_id = $caller AND conversation_id IN (SELECT id FROM conversations WHERE task_id = $taskId)`. The bulk form avoids the per-cid loop's transaction-round-trip cost on tasks with many conversations.
   - **Task participant deletion** — one DELETE: `DELETE FROM task_participants WHERE task_id = $taskId AND agent_id = $caller`.
   - **Last-participant closure check** — if the remaining `task_participants` count for `taskId` is zero, transition `tasks.status = 'closed'` and enqueue `TaskClosedNotificationDefinition` with payload `{ task }` (matching the EXISTING notification shape; the spec body Goal 2 reference to `{ taskId }` is a shorthand — the wire shape is the canonical `{ task: Task }`).
   - **Per-conversation removal notifications** — enqueue one `TaskConversationParticipantsRemovedNotificationDefinition` per `conversation_id` in the snapshot, with `{ taskId, conversationId, removedAgentId: callerAgentId, reason: "task_leave" }`.
4. **Post-commit** — broadcast all enqueued notifications via `broadcastNotificationToAgents`. Broadcast failure does NOT roll back the DB write (best-effort delivery).

Additional contract clauses (spec body Goal 2):

- **Last-participant in individual conversations** — left in place (NOT auto-archived). No `TaskConversationArchive` notification fires from `TaskLeave`.
- **TM unaffected** — `tasks.app_id` does NOT change; TMs are not participants.
- **Owner is not special** — task closure rule applies even if the owner leaves.

## Participant invariant: TaskConversationAddParticipant

Data-flow contract (impl-staff translates to Effect+Kysely; non-normative):

1. **Decode** — schema validates `taskId`, `conversationId`, `agentId`.
2. **Authority** — `TmAuthority` (Spec E) for `taskId`.
3. **Invariant check** — verify `(task_id = $taskId, agent_id = $agentId)` exists in `task_participants`. Missing row = fail with `ParticipantNotAdmittedError`. The server auto-admits every invitee at TaskCreate today (`admittedAt` is non-null on every row), so the membership check is sufficient. The `admittedAt`-null branch + the `WHERE admitted_at IS NOT NULL` read filters are kept in place for a future "pending invitation" flow.
4. **Conversation-in-task verification** — verify `(conversations.id = $conversationId AND conversations.task_id = $taskId)`. Mismatch = `NotFoundError` (cross-task `conversationId` rejected).
5. **Insert** — `INSERT INTO conversation_participants (conversation_id, agent_id) ON CONFLICT DO NOTHING` inside a transaction.
6. **Notification** — `TaskConversationParticipantsAddedNotificationDefinition` enqueues AFTER the participant insert returns. Broadcast is best-effort: `notification-broadcast.ts` calls `NetworkSendService.broadcast`, which forks socket writes via `Effect.runFork` and does not participate in the participant-insert transaction.

### TaskConversationRemoveParticipant last-removal

When `TaskConversationRemoveParticipant` removes the last remaining
agent from a conversation's `conversation_participants` (i.e. the
post-mutation count is zero), the conversation is **left in place,
not auto-archived** — same semantics as `TaskLeave`'s
last-participant-in-conversation rule. No `TaskConversationArchive`
notification fires; the conversation row stays with
`archivedAt IS NULL`.

## Authority gates per operation

| Method | Authority |
|---|---|
| `TaskCreate` | any authenticated agent + `requireContactPolicyForCreate` |
| `TaskLeave` | self only |
| `TaskConversationCreate` | TM only + participant-admitted invariant |
| `TaskConversationList` | self only (caller ∈ `conversation_participants`) |
| `TaskConversationArchive` | TM only |
| `TaskConversationUnarchive` | TM only |
| `TaskConversationAddParticipant` | TM only + participant-admitted invariant |
| `TaskConversationRemoveParticipant` | TM only |

### "TM only" — what that means today

TM authority is proved by the calling WS connection being the
registered remote-app connection for `tasks.app_id`. Apps register via
the wire `AppsRegister` RPC; `AppHost.isAppConnection(appId, connId)`
does the lookup. A `MoltZapTMClient` that has `AppsRegister`'d its
manifest can call the TM-only RPCs over the wire from that connection.
Server-internal app-host code (in-process `dispatch_authorize` /
`message_authorize` callbacks) also drives them when the in-process
hook is registered.

## Capability list per handler

Each `defineRpc` in `packages/protocol/src/task/tasks.ts` declares its
capability tags in `capabilities: [{ tag, argsOf }]`. The dispatcher
(`packages/protocol/src/transport/dispatch.ts →
applyCapabilityProvisioning`) auto-threads
`Effect.provideServiceEffect(tag, providerEffect)` per frame from the
shared provider table in
`packages/server/src/app/capability-providers.ts →
serverCapabilityProviders`. Handler bodies just call the service
method; the service yields the tag and the dispatcher's lazy provision
runs the obtain helper at first yield. The compile-time lockstep gate
(Canary 7 in
`packages/protocol/src/transport/typed-dispatcher.types-check.ts`)
rejects any handler whose R channel references a tag NOT declared in
the descriptor's `capabilities` array.

| Handler | Descriptor `capabilities` | Notes |
|---|---|---|
| `TaskCreate` | (none declared) | `obtainContactPolicyForCreate` stays inline-piped (conditional on `invitedAgentIds.length > 0`); `obtainConversationCreateAuthorization` stays inline-piped inside `mintInitialConversation` (conditional on `initialConversation`). Both conditions fail the static `argsOf` shape; pattern matches the `MessagesSend` Spec F §3 carve-out. |
| `TaskLeave` | (none declared) | Self-auth via `ctx.agentId`; `taskService.leaveTask` does not require any capability tag. |
| `TaskConversationCreate` | `[TmAuthority, ConversationCreateAuthorization]` | Handler explicitly `yield* TmAuthority` BEFORE `requireAgentsAreInTaskParticipants` to force the lazy obtain helper to execute ahead of the participant-admitted probe (auth-first invariant). `ConversationCreateAuthorization` is consumed inside `conversationService.create`. |
| `TaskConversationList` | (none declared) | Self-auth via `ctx.agentId`; the underlying `conversationService.list` does not require any capability tag. |
| `TaskConversationArchive` | `[TmAuthority, ConversationInTask]` | Both tags consumed inside `taskService.archiveTaskConversation`. |
| `TaskConversationUnarchive` | `[TmAuthority, ConversationInTask]` | Both tags consumed inside `taskService.unarchiveTaskConversation`. |
| `TaskConversationAddParticipant` | `[TmAuthority, ConversationInTask]` | Handler explicitly `yield* TmAuthority` BEFORE `requireAgentsAreInTaskParticipants` (auth-first invariant). `ConversationInTask` is consumed inside `taskService.addTaskConversationParticipant`. |
| `TaskConversationRemoveParticipant` | `[TmAuthority, ConversationInTask]` | Both tags consumed inside `taskService.removeTaskConversationParticipant`. |

The four `TaskConversation{Archive,Unarchive,AddParticipant,RemoveParticipant}`
descriptors share `tmAuthorityArgsOfTask` / `conversationInTaskArgsOfPair`
builders in `tasks.ts` so their identical capability shapes cannot drift.

The auth-first explicit yield matters: lazy `Effect.provideServiceEffect`
runs the provider only at first tag-yield inside the composed effect, so
without the explicit `yield* TmAuthority` a non-TM caller could see
`ParticipantNotAdmittedError` from `requireAgentsAreInTaskParticipants`
(a side-channel probe for task membership) instead of `ForbiddenError`.

## Notification emission

For each mutating operation, the server enqueues the matching
`task/conversation/*` notification AFTER the row mutation returns.
Broadcast is best-effort post-call: `notification-broadcast.ts` forks
socket writes via `Effect.runFork` inside `NetworkSendService`, so a
rollback BEFORE the enqueue line emits zero notifications.

| Mutating op | Notification |
|---|---|
| `task/conversation/create` | `task/conversation/created` |
| `task/conversation/archive` | `task/conversation/archived` |
| `task/conversation/unarchive` | `task/conversation/unarchived` |
| `task/conversation/participants/add` | `task/conversation/participants/added` |
| `task/conversation/participants/remove` | `task/conversation/participants/removed` |
| `task/create` with `initialConversation` | `task/conversation/created` (mirrors the atomic conversation insert) |
| `task/leave` (per conversation the leaver was in) | `task/conversation/participants/removed { reason: "task_leave" }` (one per cid) |
| `task/leave` (last-participant-task-closure case) | `task/closed { task }` |

`TaskCreate` without `initialConversation` does NOT emit any
conversation notification (no conversation row created).

## Test alignment

- **Conformance suite** — each new RPC + notification gets a
  conformance property under
  `packages/protocol/src/testing/conformance/task/` mirroring the
  existing `conversation-lifecycle.ts` shape. Property list:
  schema-decode failure, authority denial, happy path, participant
  invariant (where applicable), task/conversation mismatch,
  idempotency, transaction rollback, notification payload shape,
  pagination + visibility (`task/conversation/list`).
- **Integration suite** — per-handler test file under
  `packages/server/src/__tests__/integration/task/` mirrors the
  existing `tasks.*.test.ts` shape; new tests cover the dedup
  query, atomic init-conversation, and the participant-admitted
  invariant.
- **Type canaries** — `packages/protocol/src/task/task-conversation-family.types-check.ts`
  encodes 5 invariants: wire-name namespace lock,
  `TaskCreate` params shape, `DEFAULT_APP_ID` brand, list-item
  shape, removed-reason discriminator, and the negative-canary
  block for explicitly-rejected symbols.

## Cold-start reading order

1. `tasks.ts` — descriptor definitions (single source of truth).
2. This doc — flow walkthroughs + authority matrix + dual-emit table.
3. `task-conversation-family.types-check.ts` — locked invariants.
4. `packages/server/src/task/handlers/tasks.handlers.ts` (impl-staff
   output) — concrete handler bodies that delegate to existing
   `taskService` / `conversationService`.
