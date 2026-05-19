# R-channel capabilities

> **Status (Spec E #601):** primitives + `TaskService` cutover live;
> `ConversationService` + `MessageService` public-method cutover gated
> on a structural split of those service files (see §7).
> Plan: [architect plan #606](https://github.com/chughtapan/moltzap/issues/606). Spec: [#601](https://github.com/chughtapan/moltzap/issues/601).

This doc explains the typed-capability pattern that lifts the prior
`requireX`-style runtime authority checks into Effect's `R` channel.
It is the canonical reference for "how do I add a capability?" and
"why is my handler missing a `provideServiceEffect` call?".

Capability primitives live in `packages/server/src/app/capabilities/`.
Each capability is a nominal `Context.Tag` whose value type carries the
runtime IDs + already-fetched payload row produced by today's `requireX`
runtime check. The obtain helper queues the check; the handler pipes the
helper into the service method via `Effect.provideServiceEffect`; the
compiler enforces that the obtain call site exists at all.

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
storeMessage(
  /* ... */
): Effect.Effect<Message, TaskServiceError, TmAuthority>;
```

A handler that calls `storeMessage` MUST drain `TmAuthority` via
`Effect.provideServiceEffect(TmAuthority, obtainTmAuthority(...))`
before the effect leaves the wrapper, or the `defineTaskMethod`
constraint `Reqs extends TaskTags` rejects the body at compile time.
The `capability-r-channel.types-check.ts` Canary 5 enforces this
wrapper-boundary invariant.

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

## 4. Migration recipe — adding a capability to an existing method

`TaskService` is migrated (all 10 public methods consume capability
tags via the R-channel). `ConversationService` + `MessageService`
public methods still inline the gate call; their cutover is gated on
a structural split of `conversation.service.ts` / `message.service.ts`
to fit the `max-lines: 1050` lint cap with the added R-channel
plumbing.

The recipe (same shape per site, applies both to the migrated
`TaskService` sites and to the un-migrated `ConversationService` /
`MessageService` sites when their cutover lands):

1. **Define the tag + obtain helper** in `app/capabilities/`. One file
   per capability: Tag class + value type + obtain helper. Wire it into
   `app/capabilities/index.ts` AND into the `CapabilityTags` sibling
   alias in `transport/layer-tags.ts`.
2. **Promote any consumed gate helper** to `@internal` exported on the
   service class (Decision B / Option A). Drop the `private` modifier;
   add a JSDoc block ending with `@internal`. Spec E (#601) renamed
   the gate-helper prefix from `requireX` to `assertX` / `loadX` so
   the audit grep stays clean.
3. **Service method:** add the tag to its R channel:
   `Effect.Effect<A, E, MyTag>`. Replace
   `yield* this.assertX(...)` with `yield* MyTag` + a one-line
   `assertCapabilityMatchesTask` check (when the method also takes the
   raw `taskId` as a parameter — to catch "handler obtained for task A,
   passed task B").
4. **Handler:** add
   `Effect.provideServiceEffect(MyTag, obtainMyTag(...))` to the
   handler body's pipe. The `defineTaskMethod` constraint
   `Reqs extends TaskTags` rejects the handler if it forgets to
   drain.
5. **Type-canary update** if the new tag participates in a union-shape
   semantics (rare; usually only for MessagesSend's composite).

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

The `ConversationService` + `MessageService` public methods (`create`,
`addParticipant`, `update`, `archive`, `unarchive`, `mute`, `unmute`,
`removeParticipant`, `sendInsert`, `list`) also stay on the inline-gate
shape — their R-channel cutover lands when `conversation.service.ts` /
`message.service.ts` get restructured to fit the `max-lines: 1050` lint
cap with the added signature plumbing. The obtain helpers are in place;
the cutover follows the recipe in §4.

The infrastructure handlers (`Connect`, `AppsRegister`,
`MessagesAuthorize`) stay out of scope — different authentication
patterns, separate follow-up.

## 8. Cross-references

- Capability primitives: `packages/server/src/app/capabilities/`
- Service-layer composition: [01-service-layer-composition.md](./01-service-layer-composition.md)
- Request → response handling (where `defineXxxMethod` lives):
  [03-request-response-handling.md](./03-request-response-handling.md)
- Layer-tag hierarchy:
  `packages/server/src/transport/layer-tags.ts`
- Type-canary (Decision A gate + wrapper-boundary gate):
  `packages/server/src/app/capabilities/capability-r-channel.types-check.ts`
- Architect plan: [#606](https://github.com/chughtapan/moltzap/issues/606)
- Spec: [#601](https://github.com/chughtapan/moltzap/issues/601)
