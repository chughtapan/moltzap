# 12 — Task / TaskConversation family (Spec D1)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Spec D1 (issue #598) adds an additive `task/*` + `task/conversation/*`
RPC and notification surface alongside the legacy `tasks/*` +
`conversations/*` families. The legacy descriptors stay live during a
bounded transitional window; Spec D3 (#600) deletes them and the
parallel notification emission inside the same orchestration (parent
epic #602).

This doc covers the new surface only. See `01-method-definition.md` for
how `defineRpc` / `defineNotification` build descriptors, and
`05-notification-fanout.md` for the encode side of notifications.
Server-side handler structure (`tasks.handlers.ts` extensions, service
delegation, dual emission) is detailed in
`packages/server/src/task/handlers/` — impl-staff target.

## Wire surface

### RPCs

| Wire name | Const | Authority | Replaces |
|---|---|---|---|
| `task/create` | `TaskCreate` | any agent + contacts | `tasks/create` |
| `task/leave` | `TaskLeave` | self | (new) |
| `task/conversation/create` | `TaskConversationCreate` | TM | `tasks/createConversation` |
| `task/conversation/list` | `TaskConversationList` | self | (new; replaces `conversations/list`) |
| `task/conversation/archive` | `TaskConversationArchive` | TM | `tasks/closeConversation` |
| `task/conversation/unarchive` | `TaskConversationUnarchive` | TM | (new) |
| `task/conversation/participants/add` | `TaskConversationAddParticipant` | TM + admitted | `conversations/addParticipant` |
| `task/conversation/participants/remove` | `TaskConversationRemoveParticipant` | TM | `conversations/removeParticipant` |

### Notifications

| Wire name | Const | Recipients (impl-staff target) |
|---|---|---|
| `task/conversation/created` | `TaskConversationCreatedNotificationDefinition` | initial `participants` list |
| `task/conversation/archived` | `TaskConversationArchivedNotificationDefinition` | post-mutation `conversation_participants` |
| `task/conversation/unarchived` | `TaskConversationUnarchivedNotificationDefinition` | post-mutation `conversation_participants` |
| `task/conversation/participants/added` | `TaskConversationParticipantsAddedNotificationDefinition` | post-mutation membership (newcomer included) |
| `task/conversation/participants/removed` | `TaskConversationParticipantsRemovedNotificationDefinition` | pre-mutation membership (removed agent still receives) |

`task/conversation/updated` is NOT defined — Spec D1 explicitly removes
the conversation-update flow (set-at-create-time only). The dispatch
brief listing it is stale relative to spec body Goal 1+5.

## Naming decision: singular `task/*`

The new namespace is singular (`task/create`, `task/leave`,
`task/conversation/*`). The legacy family is plural (`tasks/create`,
`tasks/createConversation`). Singular vs. plural lets both wire names
coexist during the dual-emit window without collision; the
single-word boundary also matches the per-flow doc title and is
easier to grep for in client code.

D3 (#600) deletes the plural `tasks/*` family; only the singular
`task/*` family survives.

## DEFAULT_APP_ID — server-bundled default app

```ts
export const DEFAULT_APP_ID = "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb" as AppId;
```

One app for every DM and every Group. The `conversation_type` enum
(`dm` / `group`) becomes a display-only label derived from participant
count; D3 retires the column. Capacity is uniform 256 per conversation.

Server boot wiring (impl-staff target, replaces
`packages/server/src/app/layers.ts` → the two existing default-TM
registrations):

```ts
// Before (D1 still has both registrations; D3 deletes them):
//   yield* registry.register(DEFAULT_DM_TM_ADDRESS, makeDefaultTmHandler("dm"));
//   yield* registry.register(DEFAULT_GROUP_TM_ADDRESS, makeDefaultTmHandler("group"));
//
// D1: keep above (transitional) + add the single default-app TM registration.
// D3: delete above, leave only the default-app TM registration.
```

The `tm_endpoint_address` for the default app derives from
`DEFAULT_APP_ID` via the app-tm-registry lookup (the registry's
existing one-app-to-one-TM contract). No new schema column required.

## TaskCreate flow

Data-flow contract (impl-staff translates to Effect+Kysely; this is
NOT normative pseudocode):

1. **Decode** — schema validates `appId` is a UUID-shaped branded string; `invitedAgentIds` is `AgentId[]` (may be empty); `initialConversation` is optional.
2. **Empty invited / self-included** — `invitedAgentIds` MAY be empty (creates a self-only task; the caller is the sole `task_participant`). `invitedAgentIds` MAY include the caller; the server normalizes the participant set as `{caller} ∪ invitedAgentIds` (set semantics) so the caller is never double-counted.
3. **Dedup hit (appId === DEFAULT_APP_ID only)** — the server queries `task_participants` for an existing task whose **set of admitted-OR-pending agent rows** (i.e. all rows under `task_participants(task_id)` regardless of `admittedAt IS NULL`) exactly equals `{caller} ∪ invitedAgentIds` AND whose `tasks.app_id = $appId`. If hit, returns the existing task (no conversation mint even when `initialConversation` is supplied — dedup is task-level, not conversation-level). Index expectation: the existing `task_participants` PRIMARY KEY `(task_id, agent_id)` covers the matching predicate; a supplementary `task_participants_agent_id` index (if present) accelerates the participant-set reverse lookup. Impl-staff confirms the index list against `core-schema.sql` before the SELECT lands.
4. **Mint** — if no dedup hit, the server inserts a new `tasks` row + one `task_participants` row per agent in `{caller} ∪ invitedAgentIds`, all inside one transaction.
5. **Atomic initial conversation** — if `initialConversation` is supplied, the same transaction also calls `conversationService.create({…})` to mint the first conversation. Both notifications (`task/conversation/created` AND legacy `conversations/created`) enqueue inside the same transaction and broadcast post-commit.
6. **Return** — `{ task, conversation: Conversation | null }`. `conversation` is non-null iff `initialConversation` was supplied AND the dedup query missed.

The dedup query matches via `task_participants` (the task-level
participant table). This is a NEW query shape; the existing
`conversationService.existingDmForCreate` matches via
`conversation_participants` for the legacy 2-participant DM case and
is NOT a generalization of the new dedup. Impl-staff lands the new
helper `conversationService.findExistingTaskByParticipants(callerId,
invitedAgentIds, appId)` as a sibling of `existingDmForCreate`, not a
refactor of it.

The single-invitee DM case under `DEFAULT_APP_ID` is functionally
equivalent to today's DM-dedup behavior (one extant task per agent
pair) at the OBSERVABLE layer. The IMPLEMENTATION queries are
distinct tables (today's runs against `conversation_participants`;
D1's runs against `task_participants`); the new helper is a sibling,
not a refactor.

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
   - **Per-conversation removal notifications** — enqueue one `TaskConversationParticipantsRemovedNotificationDefinition` per `conversation_id` in the snapshot, with `{ taskId, conversationId, removedAgentId: callerAgentId, reason: "task_leave" }`. Dual-emit the legacy `participants/removed` per the dual-emission table below.
4. **Post-commit** — broadcast all enqueued notifications via `broadcastNotificationToAgents`. Broadcast failure does NOT roll back the DB write (best-effort delivery).

Additional contract clauses (spec body Goal 2):

- **Last-participant in individual conversations** — left in place (NOT auto-archived). No `TaskConversationArchive` notification fires from `TaskLeave`.
- **TM unaffected** — `tm_endpoint_address` does NOT change; TMs are not participants.
- **Owner is not special** — task closure rule applies even if the owner leaves.

## Participant invariant: TaskConversationAddParticipant

Data-flow contract (impl-staff translates to Effect+Kysely; non-normative):

1. **Decode** — schema validates `taskId`, `conversationId`, `agentId`.
2. **Authority** — `TmAuthority` (Spec E) for `taskId`.
3. **Invariant check** — verify `(task_id = $taskId, agent_id = $agentId)` exists in `task_participants`. Missing row = fail with `ParticipantNotAdmittedError`. Existing row admitted-or-pending (i.e. `admittedAt` may be NULL) — both are accepted; admission state is a separate gate.
4. **Conversation-in-task verification** — verify `(conversations.id = $conversationId AND conversations.task_id = $taskId)`. Mismatch = `NotFoundError` (cross-task `conversationId` rejected).
5. **Insert** — `INSERT INTO conversation_participants (conversation_id, agent_id) ON CONFLICT DO NOTHING` inside a transaction.
6. **Dual-emit notifications** — `TaskConversationParticipantsAddedNotificationDefinition` AND legacy `ParticipantsAddedNotificationDefinition` enqueue in the same tx; broadcast post-commit.

The invariant is NEW in D1. Today's `ConversationsAddParticipant`
does NOT check `task_participants` membership; D1's
`TaskConversationAddParticipant` does. Legacy
`ConversationsAddParticipant` keeps its current behavior during the
transitional window; D3 deletes it.

### TaskConversationRemoveParticipant last-removal

When `TaskConversationRemoveParticipant` removes the last remaining
agent from a conversation's `conversation_participants` (i.e. the
post-mutation count is zero), the conversation is **left in place,
not auto-archived** — same semantics as `TaskLeave`'s
last-participant-in-conversation rule (spec body Goal 2). No
`TaskConversationArchive` notification fires; the conversation row
stays with `archivedAt IS NULL`. D3 may revisit if product input
demands auto-archive; D1 keeps the conservative behavior.

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

## Capability list per new handler (impl-staff target)

D1 impl-staff dispatch is HARD-blocked on Spec E (#601) Phase 1
(primitives PR — `TmAuthority` `Context.Tag` + `obtainTmAuthority`
helper) merging first. Every new handler is born with the Spec E
R-channel capability chain per the matrix below; there is no
runtime-only fallback path. If Spec E Phase 1 has not landed when D1
impl-staff dispatches, the orchestrator BLOCKs with a `NEEDS_CONTEXT`
verdict pointing at Spec E (#606). See plan §R5 + §14.

| Handler | Capability list (Spec E shape) |
|---|---|
| `TaskCreate` | `[ContactPolicyAllowsReach]` (only when `invitedAgentIds` non-empty) |
| `TaskLeave` | `[]` (self-auth via `ctx.agentId`; no obtain) |
| `TaskConversationCreate` | `[TmAuthority, AgentInTaskParticipants]` (one per invited agent) |
| `TaskConversationList` | `[]` (self-auth) |
| `TaskConversationArchive` | `[TmAuthority, ConversationInTask]` |
| `TaskConversationUnarchive` | `[TmAuthority, ConversationInTask]` |
| `TaskConversationAddParticipant` | `[TmAuthority, ConversationInTask, AgentInTaskParticipants]` |
| `TaskConversationRemoveParticipant` | `[TmAuthority, ConversationInTask]` |

Spec F (#617) consumes these arrays at the dispatcher; D1 impl-staff
populates the arrays at Spec E wiring time (the two land together at
the handler call site). The descriptor stubs in `tasks.ts` are Spec
F-compatible (no `slotDisposition` or `capabilities` field added; the
future Spec F edit just decorates each `defineRpc(...)` call).

## Dual emission during D1

For each mutating operation, the server enqueues BOTH the legacy
`conversations/*` notification AND the new `task/conversation/*`
notification inside the same transaction. Recipients (notification
fan-out) is unchanged from the legacy semantics; the new payload
shapes carry `taskId` explicitly (legacy payloads did not).

| Mutating op | Legacy notif | New notif |
|---|---|---|
| `conversations/create` / `task/conversation/create` | `conversations/created` | `task/conversation/created` |
| `conversations/archive` / `task/conversation/archive` | `conversations/archived` | `task/conversation/archived` |
| `conversations/unarchive` / `task/conversation/unarchive` | `conversations/unarchived` | `task/conversation/unarchived` |
| `conversations/addParticipant` / `task/conversation/participants/add` | `participants/added` | `task/conversation/participants/added` |
| `conversations/removeParticipant` / `task/conversation/participants/remove` | `participants/removed` | `task/conversation/participants/removed` |
| `task/create` with `initialConversation` | `conversations/created` (mirrors the atomic conversation insert) | `task/conversation/created` |
| `task/leave` (per conversation the leaver was in) | `participants/removed` (one per cid) | `task/conversation/participants/removed { reason: "task_leave" }` (one per cid) |
| `task/leave` (last-participant-task-closure case) | (no legacy mirror — `task/closed` is a server-emitted task-level notification with no legacy alias; `TaskClosedNotificationDefinition` already exists pre-D1) | `task/closed { task }` (existing definition, unchanged) |

The two new rows (`task/create` with `initialConversation`,
`task/leave`) extend dual-emission to cover every D1 mutation that
affects `conversation_participants` or `conversations` rows.
`TaskCreate` without `initialConversation` does NOT emit any
conversation notification (no conversation row created).

D3 deletes the legacy column. The deprecation-log warning at legacy
handler entry (spec body Contract decision) fires once per call
during D1 and goes away with the legacy handler in D3. `task/create`
and `task/leave` are new wire methods (no legacy alias to
deprecation-log).

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
