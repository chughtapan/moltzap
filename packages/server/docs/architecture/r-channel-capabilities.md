# R-channel capabilities

> **Status:** capability primitives are live AND the Spec F handler
> refactor is shipped. Twelve task-layer descriptors declare their
> capabilities on `RpcDefinition.capabilities` and the dispatcher
> auto-provisions them at request time. `MessagesSend` is the one
> structural exception — its `conversationId` needs resolution
> (`to:` / `replyToId:` → DB lookup) before the obtain helper runs,
> so its handler hand-pipes `MessageSendPermission`. See
> `packages/protocol/src/task/messages.ts → MessagesSend` for the
> design rationale.

This doc explains the typed-capability pattern that lifts the prior
`requireX`-style runtime authority checks into Effect's `R` channel.

Capability **tag classes** + value types live in
`packages/protocol/src/task/capabilities/`. **Obtain helpers** (which
yield `TaskServiceTag` / `ConversationServiceTag` / `MessageServiceTag`)
live in `packages/server/src/app/capabilities/`. The dispatcher reads
each descriptor's `capabilities: [...]` array and threads
`Effect.provideServiceEffect` from a shared provider table at
`packages/server/src/app/capability-providers.ts`. Handler bodies
yield the tag value without piping anything; the compile-time gate
(`packages/protocol/src/transport/typed-dispatcher.types-check.ts →
Canary 7`) catches a handler that yields a tag NOT declared on its
descriptor.

## 1. The bug class this catches

Pre-Spec-E, every privileged service method opened with a runtime call
like:

```ts
yield* this.requireTmAuthority(taskId, caller);
```

Forgetting that call was a runtime bug — the type system could not see
which methods required the precondition, so the failure mode was
"unauthenticated access lands in production until the next integration
test exercises the path." Spec #601 §Intent names this as the bug class
the migration eliminates.

R-channel capabilities encode the precondition in the method's *type
signature*:

```ts
sendInsert(
  /* ... */
): Effect.Effect<Message, MessageServiceError, TmAuthority | ConversationInTask | MessageSendPermission>;
```

Each task-layer descriptor's `capabilities: [...]` array names the tags
its handler needs. The dispatcher reads that array per inbound frame,
calls the matching provider entry from `app/capability-providers.ts`,
and threads `Effect.provideServiceEffect` over the handler before
invoking. Handlers yield the capability values directly. The
compile-time lockstep gate (`typed-dispatcher.types-check.ts → Canary 7`)
rejects handler bodies that yield a tag not declared on the
descriptor.

## 2. Two capability shapes

Capabilities come in two flavors:

### Obtain shape

`obtain*` helpers query the database (or invoke an `@internal` service
helper that does) and produce `Tag + payload row`. The payload is
carried inside the capability value so service-method bodies don't
re-fetch what the obtain helper already proved.

```ts
// app/capabilities/tm-authority.ts
export const obtainTmAuthority = (
  taskId: TaskId,
  caller: AgentId,
): Effect.Effect<TmAuthorityValue, TaskServiceError, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.requireTmAuthority(taskId, caller);
    return { task, callerAgentId: caller };
  }).pipe(Effect.withSpan("obtainTmAuthority"));
```

`requireTmAuthority` enforces byte-equality between the task's
`tm_endpoint_address` and `endpointAddressForAgent(caller) =
"tm:agent:<caller>"`. Tasks created via the wire `TaskCreate` always
bind to `tm:app:<appId>` (the app is the TM), so a regular agent WS
connection cannot pass `TmAuthority` over the wire — the TM-only
RPCs (`TaskConversationCreate`, `TaskConversationArchive`,
`TaskAddParticipant`, `TaskClose`, etc.) are reachable only from
server-internal app-host code paths.

The address layer is being collapsed onto `tasks.app_id` so a
`MoltZapTMClient` that has `AppsRegister`'d its app can pass the
gate over the wire. Tracking: [#673](https://github.com/chughtapan/moltzap/issues/673).

### Refine shape

`refine*` helpers validate an already-fetched row inline — no DB read.
They're used when the caller already has the row in hand (e.g. inside
`obtainMessageSendPermission` after `readSendConversation`).

```ts
// app/capabilities/task-active.ts
export const refineTaskActive = (
  taskId: TaskId,
  status: TaskStatus,
): Effect.Effect<TaskActiveValue, TaskClosedError> => {
  if (status === "closed" || status === "failed") {
    return Effect.fail(new TaskClosedError({ /* ... */ }));
  }
  return Effect.succeed({ taskId, status });
};
```

## 3. The composite capability path (`MessageSendPermission`)

`MessagesSend` has the most complex precondition set:

- caller must be a conversation participant
- conversation must belong to the named task
- task must accept messages OR caller must be the TM
- if `replyToId` is provided, the message must exist in the conversation

Spec #601 §MessagesSend composite shape proposed encoding this as a
union-of-tags R-channel:

```ts
R extends ConversationParticipantAccess
        & ConversationInTask
        & (TaskActive | TmAuthority)
        & (ValidReplyTarget | NoReplyTarget)
```

This shape DOES NOT WORK in Effect: the R channel uses union types to
ENCODE a set of required services. `Effect<A, E, T1 | T2>` requires
BOTH `T1` AND `T2` to be provided. There is no native "exactly one
of" semantics in `provideServiceEffect`. See Architect Decision A in
plan #606 for the full analysis; the
`capability-r-channel.types-check.ts → Canary 2` documents this with
an `@ts-expect-error`.

Spec E ships a composite `MessageSendPermission` capability instead —
one `Context.Tag` whose value is a discriminated union over the three
legal authorization paths:

- `forParticipantOnActiveTask` — open task + conversation participant
- `forTmBypass` — caller IS the TM (bypasses "task is open")
- `forTmBypassWithReply` — TM bypass + verified reply target

The handler picks the right constructor at `provideServiceEffect` time
based on input shape; the service-method body destructures via `_tag`.

## 4. Migration recipe — adding a NEW capability to an existing method

1. **Define the tag + value type** in
   `packages/protocol/src/task/capabilities/<name>.ts`. Tag class +
   value-type interface only — pure protocol types, no server deps.
   Re-export from the `capabilities/index.ts` barrel.
2. **Add the obtain helper** in
   `packages/server/src/app/capabilities/<name>.ts`. Importing the tag
   from `@moltzap/protocol/task`. Wire into the
   `CapabilityTags` sibling alias in `transport/layer-tags.ts`.
3. **Service method:** add the tag to its R channel:
   `Effect.Effect<A, E, MyTag>`. Body destructures the tag's value
   via `yield* MyTag` and uses the carried proof rows.
4. **Descriptor:** add `{ tag: MyTag, argsOf: (params, ctx) => ... }`
   to the descriptor's `capabilities: [...]` array. `argsOf` returns
   the shape the provider entry takes (typically `{ taskId,
   callerAgentId }` or similar; cast `params`/`ctx` internally since
   they're typed `unknown` at the descriptor boundary).
5. **Provider table:** add `[MyTag.key]: (args) => obtainMyTag(...)` to
   `packages/server/src/app/capability-providers.ts`.
6. **Type-canary:** Canary 7 in
   `packages/protocol/src/transport/typed-dispatcher.types-check.ts`
   already catches handler R-channel drift; no per-tag canary needed.

When the descriptor's `argsOf` cannot derive the obtain helper's
input from raw wire params alone (e.g. `MessagesSend.conversationId`
requires `to:` / `replyToId:` resolution via DB lookup), skip step 4
+ 5 and keep the hand-piped `Effect.provideServiceEffect` in the
handler instead — like `messages.handlers.ts → handleMessageSend`.

## 5. Decision B — gate-helper visibility (`@internal` exported)

The architect plan picked Option A: gate-helper methods stay on the
service class as `@internal` exported instance methods (no `private`
modifier). Why:

- TS `private` is a compile-time access modifier; obtain helpers in
  `app/capabilities/` need to reach the underlying check via the
  service Tag. `private` blocks every caller, DI-injected or not.
- Co-locating obtain helpers inside the service modules (Option B)
  would bloat the service files (14 obtain helpers across 4 modules)
  with no enforcement payoff.
- The `CapabilityAccessors` interface (Option C) adds boilerplate +
  type churn for the same enforcement payoff as a JSDoc convention.

JSDoc `@internal` + the directory-level
`packages/server/src/app/capabilities/README.md` boundary is the
package-internal convention; lint enforcement is not currently wired.

## 6. State-proof staleness (open question Q1 in the spec)

Refine-shape capabilities (`TaskActive`, `ConversationNotArchived`)
are LIVENESS proofs — the underlying column can transition between
obtain and use. Spec #601 §Open question Q1 names this; the convention:

- Refine helpers are safe to call inside the same transaction as the
  row read.
- Cross-transaction reuse is a defect; re-obtain by re-reading the
  column.
- JSDoc on each refine helper restates the staleness window.

The composite `obtainMessageSendPermission` runs every refine inside
the same `Effect.gen` block as the `readSendConversation` projection,
so the staleness window is bounded by the request fiber.

## 7. What's NOT in the R channel

Tier 5 (identity capability `Authenticated`) stays out of scope per
spec #601 §Non-goals #5. The caller's agent ID rides as a `ctx.agentId`
parameter; migrating it touches every handler in the workspace. Spec
#601 §Open question Q3 documents the open follow-up.

The surviving `ConversationService` + `MessageService` public methods
(`create`, `removeParticipant`, `sendInsert`, `list`, archive helpers)
stay on the inline-gate shape — their R-channel cutover lands when
those services get restructured to fit the `max-lines: 1050` lint cap
with the added signature plumbing. The obtain helpers are in place;
the cutover follows the recipe in §4.

The infrastructure handlers (`Connect`, `AppsRegister`,
`MessagesAuthorize`) stay out of scope — different authentication
patterns, separate follow-up.

## 8. Cross-references

- Capability primitives: `packages/server/src/app/capabilities/`
- Service-layer composition: [01-service-layer-composition.md](./service-layer-composition.md)
- Request → response handling (where `defineXxxMethod` lives):
  [03-request-response-handling.md](./request-response-handling.md)
- Layer-tag hierarchy:
  `packages/server/src/transport/layer-tags.ts`
- Type-canary (Decision A gate + wrapper-boundary gate):
  `packages/server/src/app/capabilities/capability-r-channel.types-check.ts`
- Architect plan: [#606](https://github.com/chughtapan/moltzap/issues/606)
- Spec: [#601](https://github.com/chughtapan/moltzap/issues/601)
