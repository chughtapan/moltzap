# Data Model Refactor — `moltzap` (OSS Protocol)

## Problem

The TypeBox schemas in `@moltzap/protocol` have drifted from the canonical data model spec. The wire types carry fields that belong only to the server's internal state (`seq`, `reactions`, `isDeleted`), use a heavyweight `ParticipantRef` object where a plain `AgentId` suffices, and lack fields the spec requires (`agentType`, `metadata`, `taggedEntities`, `email`, `lastMessageTimestamp`). The Contact model is bidirectional when the spec calls for unidirectional.

This PR aligns the protocol schemas to the spec, fixes every downstream consumer (server-core, client, openclaw-channel, nanoclaw-channel, evals), and updates all tests and documentation.

---

## Changes by Entity

### 1. Message (`packages/protocol/src/schema/messages.ts`)

**Current fields:** `id, conversationId, sender (ParticipantRef), seq, replyToId?, parts, reactions?, isDeleted?, createdAt`

| Action | Field | Detail |
|--------|-------|--------|
| Remove | `seq` | Server-internal ordering; not a wire concern |
| Remove | `reactions` | Reactions stay server-side; not embedded in Message wire type |
| Remove | `isDeleted` | Soft-delete flag is server-internal |
| Rename + retype | `sender: ParticipantRefSchema` → `createdBy: AgentId` | Messages are always from agents; simplify from `{type,id}` to UUID |
| Add | `taggedEntities: Type.Optional(Type.Array(AgentId))` | Per spec |
| Keep | `replyToId?: MessageId` | Already correct |

**Downstream cascade:**

- **`methods/messages.ts`**: 
  - `MessagesListParamsSchema`: Replace `afterSeq`/`beforeSeq` with cursor-based `before?: MessageId` and `after?: MessageId`
  - `MessagesReadParamsSchema`: Replace `seq` with `upToMessageId: MessageId`
  - `MessagesReactParamsSchema`: Keep (react RPC still works, just not embedded in Message)
  - `MessagesDeleteParamsSchema`: Keep (delete RPC still works, just not exposed on wire)
  - `MessagesListResultSchema`: Uses `MessageSchema` — auto-updated

- **`server-core/services/message.service.ts`**:
  - `send()`: Map `sender_type`+`sender_id` DB columns → `createdBy: AgentId` (just the agent ID)
  - `list()`: Change `afterSeq`/`beforeSeq` filtering to `after`/`before` MessageId-based cursor pagination
  - `read()`: Accept `upToMessageId` instead of `seq`; server resolves to internal seq
  - `toWireMessage()`: Remove `seq`, `reactions`, `isDeleted` from output; rename `sender` → `createdBy`
  - Internal seq generation stays — it's the DB ordering mechanism, just not exposed on wire

- **`server-core/services/delivery.service.ts`**: Internal `upToSeq` stays (server-internal); no wire change needed

- **`server-core/services/conversation.service.ts`**: `lastReadSeq` on `ConversationParticipantSchema` needs update to `lastReadMessageId: Type.Optional(MessageId)` in wire type (server keeps internal seq)

- **`client/service.ts`**:
  - `fetchMessages()`: Use `after`/`before` MessageId params instead of `afterSeq`/`beforeSeq`
  - `markRead()`: Send `upToMessageId` instead of `seq`
  - Message handling: Access `msg.createdBy` (string) instead of `msg.sender.id`/`msg.sender.type`
  - Remove seq-based new-message detection logic; use message ID or timestamp comparison

- **`client/channel-core.ts`**:
  - `EnrichedSender` interface: Keep but source from `createdBy` (AgentId) instead of `sender.id`
  - `enrichMessage()`: Resolve agent name from `message.createdBy` instead of `message.sender.id`

- **`openclaw-channel/openclaw-entry.ts`**: Update `sender.id`/`sender.type` → `createdBy`
- **`openclaw-channel/mapping.ts`**: Update `seq` references in event extraction
- **`nanoclaw-channel/moltzap.ts`**: Update `enriched.sender.id` → `enriched.createdBy` (or enriched sender)

- **`evals/runner.ts`**: Update sender field access

- **CLI commands**: `history` display, `react`, `delete` — update field references

- **Tests**: ~30 test files with `sender`/`seq` fixtures need updating

---

### 2. Agent + AgentCard (`packages/protocol/src/schema/identity.ts`)

**Current fields:** `id, ownerUserId?, name, displayName?, description?, status, createdAt`

| Action | Field | Detail |
|--------|-------|--------|
| Add | `agentType: Type.Optional(stringEnum(["OpenClaw", "NanoClaw"]))` | Per spec |
| Add | `metadata: Type.Optional(Type.Object({ purpose: Type.Optional(Type.Array(Type.String())), description: Type.Optional(Type.String()), tags: Type.Optional(Type.Record(Type.String(), Type.String())) }))` | Per spec |

`AgentCardSchema` derives via `Type.Omit(AgentSchema, ["createdAt"])` — new fields inherited automatically.

**Downstream cascade:** Minimal. New optional fields don't break existing consumers. `RegisterParamsSchema` may accept `agentType` optionally. Server-core `AuthService` passes through.

---

### 3. User (`packages/protocol/src/schema/identity.ts`)

**Current fields:** `id, phone?, displayName, avatarUrl?, status, createdAt`

| Action | Field | Detail |
|--------|-------|--------|
| Add | `email: Type.Optional(Type.String({ format: "email" }))` | Per spec |

**Downstream cascade:** Minimal — optional field addition.

---

### 4. Contact (`packages/protocol/src/schema/contacts.ts`)

**Current model:** Bidirectional — `requesterId, targetId, status, requesterName, requesterPhone, targetName, targetPhone, agents?, lastSeenAt?`

**New model:** Unidirectional per spec:

```typescript
ContactSchema = Type.Object({
  id: ContactId,
  contactUserId: UserId,
  source: stringEnum(["phone", "manual", "email"]),
  relationship: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Object({
    tags: Type.Optional(Type.Array(
      Type.Record(Type.String(), Type.String())
    )),
  }, { additionalProperties: false })),
}, { additionalProperties: false })
```

- **Remove** `ContactStatusEnum` from wire exports
- **Add** `RelationshipType = Type.String()` as named export

**Downstream cascade:**

- **`methods/contacts.ts`**:
  - `ContactsListParamsSchema`: Remove `status` filter (no more `ContactStatusEnum` on wire)
  - `ContactsAddParamsSchema`: Change to `{ contactUserId: UserId, source: stringEnum([...]), relationship?: string }`
  - `ContactsAcceptParamsSchema` / `ContactsAcceptResultSchema`: Remove (no bidirectional accept flow)
  - `ContactIdParamsSchema`: Keep (for remove/block by ID)

- **`server-core`**: Contact service adapts internal bidirectional model to unidirectional wire type. Server can still track status internally.

- **`client/cli/commands/contacts.ts`**: Update display logic — no more `requesterName`/`targetName` fallback chain

- **`openclaw-channel/mapping.ts`**: Update `extractContactRequest`/`extractContactAccepted` — restructure for new Contact model

- **Tests**: Contact-related test fixtures in server-core integration tests, mapping tests

---

### 5. Conversation (`packages/protocol/src/schema/conversations.ts`)

**Current fields:** `id, type, name?, createdBy (ParticipantRef), createdAt, updatedAt`

| Action | Field | Detail |
|--------|-------|--------|
| Add | `metadata: Type.Optional(Type.Object({ tags: Type.Optional(Type.Array(Type.Record(Type.String(), Type.String()))) }, { additionalProperties: false }))` | Per spec |
| Add | `lastMessageTimestamp: Type.Optional(DateTimeString)` | Per spec |

**ConversationSummarySchema** — add `lastMessageTimestamp` and `metadata` here too.

**ConversationParticipantSchema** — change `lastReadSeq: Type.Integer` → `lastReadMessageId: Type.Optional(MessageId)`

**Downstream cascade:**
- `server-core/conversation.service.ts`: Map `last_message_at` → `lastMessageTimestamp`, pass through `metadata`
- `ConversationSummarySchema` already has `lastMessageAt` — rename to `lastMessageTimestamp` for consistency with spec

---

## Validators & Type Exports

**`validators.ts`**: Recompile all affected validators. Remove `messagesReactParams` and `messagesDeleteParams` if those RPC methods are removed, or keep if methods stay.

**`types.ts`**: Update re-exports — add `RelationshipType`, ensure `Contact` type reflects new shape.

**`schema/index.ts`**: No structural changes needed (uses `export *`).

---

## Test Updates

### Protocol tests (`packages/protocol/src/schema/`)
- `messages.test.ts`: Update fixtures — remove `seq`, `reactions`, `isDeleted`; rename `sender` → `createdBy` (now just AgentId string)
- `contacts.test.ts`: New Contact shape fixtures
- `conversations.test.ts`: Add `metadata`, `lastMessageTimestamp`
- `identity.test.ts`: Add `agentType`, `metadata` to Agent fixtures; `email` to User fixtures

### Server-core integration tests (`packages/server-core/src/__tests__/integration/`)
- `03-dm-messaging`: Update sender → createdBy assertions, remove seq assertions
- `04-group-chat`: Same
- `05-reactions-deletion`: Update for reactions not on wire Message, isDeleted removed
- `12-send-existing-conv`: Update sender.id → createdBy
- `13-message-history`: Replace afterSeq/beforeSeq pagination with cursor-based
- `23-reactions`: Reactions still work via RPC but not embedded in Message
- `24-read-receipts`: Update seq → upToMessageId
- `27-message-deletion`: isDeleted not on wire

### Client tests (`packages/client/src/`)
- `service.test.ts`: Update all message fixtures
- `service.integration.test.ts`: Update sender, seq, pagination references
- `channel-core` tests if any

### Channel tests
- `openclaw-channel/mapping.test.ts`: Update contact extraction, sender references
- `openclaw-channel/openclaw-entry.inbound-contract.test.ts`: Update sender references
- `nanoclaw-channel/moltzap.test.ts`: Update sender references

### Example handlers (`packages/server-core/examples/handlers/`)
- `messages.handlers.ts`: Update afterSeq/beforeSeq → after/before, seq → upToMessageId

---

## Documentation Updates

| File | Change |
|------|--------|
| `docs/concepts/messages.mdx` | Remove seq/reactions/isDeleted docs; rename sender→createdBy; add taggedEntities |
| `docs/concepts/contacts.mdx` | Replace bidirectional model docs with unidirectional |
| `docs/protocol/methods/messages-list.mdx` | afterSeq/beforeSeq → after/before cursor |
| `docs/protocol/methods/messages-delete.mdx` | Remove isDeleted reference |
| `docs/guides/message-reactions.mdx` | Note reactions not embedded in Message wire type |
| `docs/protocol/transport.mdx` | Update reconnection afterSeq reference |
| `docs/snippets/send-message-example.mdx` | Update sender → createdBy in example |

---

## Implementation Order

1. **Protocol schemas** — make all schema changes first (messages, identity, contacts, conversations)
2. **Protocol methods** — update RPC param/result schemas
3. **Protocol validators + types** — recompile, update exports
4. **Protocol tests** — fix all schema test fixtures
5. **Server-core services** — fix type errors in message, conversation, delivery services
6. **Server-core example handlers** — update handler implementations
7. **Server-core integration tests** — fix all test fixtures and assertions
8. **Client service + channel-core** — fix type errors
9. **Client CLI commands** — update field access
10. **Client tests** — fix fixtures
11. **OpenClaw channel** — update mapping, entry point, tests
12. **Nanoclaw channel** — update adapter, tests
13. **Evals** — update runner sender references
14. **Build + typecheck + test** — full verification
15. **Documentation** — update Mintlify docs

---

## Verification

```bash
pnpm build          # Protocol must compile; all consumers re-type-check
pnpm typecheck      # No TypeScript errors
pnpm test           # Unit tests pass
pnpm test:integration  # Integration tests pass
pnpm lint           # oxlint clean
```

---

## Risk Assessment

- **High-impact rename**: `sender` → `createdBy` touches 50+ locations. Systematic find-replace + type-checker catches misses.
- **Pagination model change**: `afterSeq`/`beforeSeq` → cursor-based. Server already has message IDs; query changes are straightforward.
- **Contact model replacement**: Most complex change. Server needs adapter layer between internal bidirectional model and unidirectional wire type.
- **New optional fields**: `agentType`, `metadata`, `email`, `taggedEntities`, `lastMessageTimestamp` — additive, low risk.

All changes are wire-type only. Database schema stays the same — the server maps between internal representation and wire types.

---

## Review Findings & Fixes (from /autoplan)

### Critical fixes incorporated after review:

1. **createdBy naming collision (CRITICAL)**: `ConversationSchema` already has `createdBy: ParticipantRefSchema`. To avoid type inconsistency, also change `Conversation.createdBy` to `AgentId` (conversations are always created by agents). This cascades to `ConversationCreatedEventSchema` via auto-reference.

2. **Cursor pagination subquery (HIGH)**: `after`/`before` MessageId cursors require a subquery: `WHERE seq > (SELECT seq FROM messages WHERE id = :afterId)`. Not a simple `WHERE id > :messageId` since UUIDs are not ordered.

3. **Client watermark replacement (HIGH)**: Replace `lastNotified`/`lastRead` seq-based maps in `service.ts` with "latest seen message ID" tracking. Use `createdAt` timestamp comparison for ordering since message IDs are UUIDs.

4. **MessageReadEventSchema (HIGH)**: `events.ts:36` uses `seq` directly. Change to `upToMessageId: MessageId` to match the new `MessagesReadParamsSchema`.

5. **ContactAccepted event (MEDIUM)**: Keep `ContactAcceptedEventSchema` — it auto-references `ContactSchema` which will update to the new shape. The accept flow can remain server-side with the new contact wire shape.

6. **Semver major bump (CRITICAL)**: This is a breaking change for published `@moltzap/protocol`. All consumers must upgrade atomically. Add changelog entry.

7. **CLI contacts displayName (HIGH)**: New Contact schema has no display name. CLI must resolve names via `agents/lookup` or `users/lookup` by `contactUserId`.

### Taste decisions (auto-decided per spec):
- `taggedEntities` naming (spec says `taggedEntities`, not `mentions`) — kept as spec
- `createdBy` naming (spec says `createdBy`, not `sender`) — kept as spec

### Deferred to TODOS.md:
- Custom AJV error messages for renamed fields (medium, not blocking)
- Codemod for external consumers (no known external consumers yet)
- Versioned wire types / v1+v2 coexistence (over-engineered for current scale)

---

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|---------------|-----------|-----------|----------|
| 1 | CEO | Accept premise (spec alignment is valid) | Mechanical | P6 | User filed issue, spec exists | "Just housekeeping" framing |
| 2 | CEO | Single PR (no split) | Mechanical | P6 | User explicitly said don't cut scope | Split into multiple PRs |
| 3 | CEO+DX | Add semver major bump | Mechanical | P1 | Breaking changes require major bump | Ship without version bump |
| 4 | Eng | Fix createdBy collision - unify to AgentId | Mechanical | P1+P5 | Same field name must have same type | Leave inconsistent |
| 5 | Eng | Specify subquery for cursor pagination | Mechanical | P5 | UUIDs not ordered, explicit > clever | Naive WHERE id > :id |
| 6 | Eng | Track latest message ID instead of seq | Mechanical | P3 | Pragmatic replacement for watermarks | Set-based tracking (memory cost) |
| 7 | Eng | Update MessageReadEventSchema | Mechanical | P1 | Completeness - can't leave seq on events | Leave events unchanged |
| 8 | DX | Keep taggedEntities naming per spec | Taste | P6 | Spec authority, user's issue says taggedEntities | Rename to mentions |
| 9 | DX | Keep createdBy naming per spec | Taste | P6 | Spec authority, user's issue says createdBy | Keep sender |
| 10 | DX | CLI resolves displayName via lookup | Mechanical | P1 | Users need readable output | Show raw UUIDs |

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | 6 findings, all auto-resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clean | 8 findings, 7 incorporated into plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | No UI scope detected |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | clean | 7 findings, 5 incorporated into plan |

**VERDICT:** APPROVED — 3 reviews complete, 0 unresolved critical issues. All findings incorporated or deferred with rationale.
