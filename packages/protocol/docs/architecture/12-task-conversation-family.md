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

```text
client                              server
  │
  ▼  TaskCreate({ appId, invitedAgentIds, initialConversation? })
                                      │
                                      ▼  decode (schema validates `appId` is UUID)
                                      │
                                      ▼  if appId === DEFAULT_APP_ID:
                                      │    SELECT t.id FROM tasks t
                                      │    WHERE t.app_id = $appId
                                      │      AND (caller ∪ invited) = participants(t.id)
                                      │    → if hit, return existing task (no conv mint)
                                      │
                                      ▼  else mint task:
                                      │    INSERT INTO tasks (app_id, tm_endpoint_address, …)
                                      │    INSERT INTO task_participants (caller, invited[])
                                      │
                                      ▼  if initialConversation:
                                      │    transaction:
                                      │      conversationService.create({ … })
                                      │      enqueue task/conversation/created notif
                                      │      enqueue conversations/created notif (legacy)
                                      │
                                      ▼  return { task, conversation: conv|null }
```

Dedup is implicit from input shape. No `dmDedup` flag. The single-invitee
case (the historical "DM") is just the `invitedAgentIds.length === 1`
instance of the same exact-participant-set match — the same query
`conversationService.existingDmForCreate` already runs for DMs today.

## TaskLeave flow

```text
client                              server
  │
  ▼  TaskLeave({ taskId })
                                      │
                                      ▼  decode
                                      │
                                      ▼  transaction:
                                      │    SELECT conversation_ids
                                      │      WHERE task_id = $taskId
                                      │        AND $caller ∈ conversation_participants
                                      │    for each cid:
                                      │      DELETE FROM conversation_participants
                                      │        WHERE conversation_id = cid AND agent_id = $caller
                                      │      enqueue task/conversation/participants/removed
                                      │        { reason: "task_leave" }
                                      │    DELETE FROM task_participants
                                      │      WHERE task_id = $taskId AND agent_id = $caller
                                      │    if count(task_participants WHERE task_id) == 0:
                                      │      UPDATE tasks SET status = 'closed' WHERE id = $taskId
                                      │      enqueue task/closed
                                      │
                                      ▼  commit; broadcast all enqueued notifications
                                      │
                                      ▼  return {}
```

Contract (spec body Goal 2):

- **Atomicity** — all deletions + closure + notification enqueueing inside one `transaction(this.db, …)`. Rollback = zero notifications observed.
- **Idempotency** — caller not in `task_participants` returns success (no-op).
- **Last-participant closure** — task transitions to `closed` in the same tx.
- **Last-participant in individual conversations** — left in place (NOT auto-archived).
- **TM unaffected** — `tm_endpoint_address` does NOT change; TMs are not participants.
- **Owner is not special** — task closure rule applies even if the owner leaves.

## Participant invariant: TaskConversationAddParticipant

```ts
// Pseudocode for impl-staff
const addToConversation = (taskId, conversationId, agentId) =>
  transaction(db, (trx) => Effect.gen(function* () {
    const isAdmitted = yield* trx
      .selectFrom("task_participants")
      .select("agent_id")
      .where("task_id", "=", taskId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();
    if (!isAdmitted) {
      return yield* Effect.fail(
        new ParticipantNotAdmittedError({
          message: `Agent ${agentId} is not admitted to task ${taskId}`,
        }),
      );
    }
    yield* trx.insertInto("conversation_participants").values({
      conversation_id: conversationId,
      agent_id: agentId,
    });
    // enqueue task/conversation/participants/added + legacy mirror
  }));
```

The invariant is NEW in D1. Today's `ConversationsAddParticipant`
does NOT check `task_participants` membership; D1's
`TaskConversationAddParticipant` does. Legacy
`ConversationsAddParticipant` keeps its current behavior during the
transitional window; D3 deletes it.

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

When Spec E (#601) primitives land (`TmAuthority` `Context.Tag` +
`obtainTmAuthority` helper), impl-staff wires each new handler with
the R-channel capability chain per the matrix below. D1 handlers
SHOULD be born with these capabilities (born-Spec-E) if Spec E
lands first; OTHERWISE D1 handlers temporarily use today's runtime
`requireTmAuthority(taskId, ctx.agentId)` pattern and the Spec E
migration rewires them later. Either path produces the same wire
behavior — the difference is compile-time enforcement of the
authority check.

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

Spec F (#617) consumes these arrays at the dispatcher; impl-staff for
D1 may either populate the arrays now (if Spec F primitives are in
tree) or defer to a follow-up migration once Spec F lands. The
descriptor stubs in `tasks.ts` are Spec F-compatible (no
`slotDisposition` or `capabilities` field added; the future Spec F
edit just decorates each `defineRpc(...)` call).

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

D3 deletes the legacy column. The deprecation-log warning at legacy
handler entry (spec body Contract decision) fires once per call
during D1 and goes away with the legacy handler in D3.

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
