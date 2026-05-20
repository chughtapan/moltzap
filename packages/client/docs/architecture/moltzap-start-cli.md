# `moltzap start` CLI

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Spec D2 (#599) adds a single-command CLI for starting a task with named
participants and (optionally) sending the first message in one shot.
Composes Spec D1 (#598) atomic `TaskCreate({ appId, invitedAgentIds,
initialConversation })` plus a follow-up `MessagesSend` when
`--message` is supplied.

## 1. Wire surface consumed

D2 is a pure consumer of D1's wire shapes; D2 adds **no new RPCs, no
new notifications, no new errors at the wire**. Only the CLI-local
tagged errors `InvalidAppIdError` and `UnresolvedParticipantError`
live in `commands/start.ts`.

| RPC | Provided by | When called |
|---|---|---|
| `TaskCreate` | Spec D1 (#635) → `packages/protocol/src/task/tasks.ts → TaskCreate` | Every invocation |
| `MessagesSend` | Pre-D1, unchanged | Only when `--message` is set |
| `AgentsLookupByName` | Pre-D1, unchanged | Per name-shaped participant token (uuid-shaped tokens skip the lookup) |
| `TaskConversationList` | Spec D1 (#598) → `packages/protocol/src/task/tasks.ts → TaskConversationList` | Only on `TaskCreate` dedup hit (P2-A); used by `findReusableConversation` to locate a reusable conversation under the existing task |

**All three RPCs go through `transport.ts → rpc(...)` (the CLI
`Transport` service), NOT `socket-client.ts → request(...)` (the
daemon-socket helper). D2 deliberately does not reuse
`socket-client.ts → resolveParticipant` because that helper hard-wires
the daemon-socket path — it would break `--as` direct-WS invocations
and would not be mockable via `commands/test-transport.ts →
makeFakeTransport`. Architect plan §R1 explains the divergence; the
local resolver `start.ts → resolveAgentToken` is the new helper that
covers D2's testability + transport-uniformity needs.**

`TaskCreate` is called with `{ appId, invitedAgentIds, initialConversation
}` where `initialConversation` carries `participants: invitedAgentIds`
ONLY when `invitedAgentIds.length > 0` — the caller-only path
(`invitedAgentIds === []`) MUST omit the `participants` field entirely
because `InitialConversationSchema.participants` is
`Type.Optional(Type.Array(AgentId, { minItems: 1 }))` (P2-B carve-out
named in spec D2 amendment N7; pinned by `start.test.ts →
zeroParticipants`). The server adds the caller to both
`task_participants` and `conversation_participants` implicitly.

Per D1 plan §R8 / Canary `_C5` the response shape is
`{ task, conversation: Conversation | null }`. The `conversation === null`
branch fires on the **dedup hit** path: when `appId === DEFAULT_APP_ID`
AND the caller already owns a task with the exact same
`{caller} ∪ invitedAgentIds` participant set, the server returns the
existing task with no new conversation (D1 Goal 3 — dedup is task-level,
not conversation-level). The CLI MUST NOT treat this as a decode error
(P2-A); instead it auto-fetches a reusable conversation under the
existing task via `findReusableConversation` and reprints the standard
`Task started:` line with a `reusing existing conversation:` label.

## 2. Command shape

```
moltzap start <name> <participant>... [--message <text>] [--app-id <uuid>]
```

- `<name>` — required positional. Conversation name (shown by
  `moltzap conversations list`).
- `<participant>...` — zero-or-more positional tokens, each
  `agent:<name>` or `agent:<uuid>`. Empty admitted (caller-only task
  per D1 spec body Goal 5; spec D2 ACs do not require, but impl-staff
  handler MUST NOT reject).
- `--message <text>` — optional. If supplied, a follow-up
  `MessagesSend` runs after the atomic `TaskCreate`.
- `--app-id <uuid>` — optional. Defaults to `DEFAULT_APP_ID`
  (D1 plan §R3, exported from `@moltzap/protocol`). Syntactic UUID v4
  validation happens client-side BEFORE any RPC; server rejection of a
  syntactically valid UUID still produces a `TransportError` at exit 1.

DM-vs-Group is **implicit** from participant count: exactly one
invited agent (caller + 1 = 2 participants) is today's DM shape;
two-or-more invited agents (caller + N = ≥3) is today's group shape.
No `--dm` / `--group` flag (spec D2 Goal 1).

## 3. Flow

```mermaid
sequenceDiagram
    participant shell
    participant cli as @effect/cli
    participant start as start.ts → startCommandHandler
    participant tx as transport.ts → rpc

    shell->>cli: moltzap start <name> agent:bob ... [--message <txt>] [--app-id <uuid>]
    cli->>start: StartCommandArgs

    Note over start: 1. validateAppIdSyntax(args.appId)<br>invalid → InvalidAppIdError → exit 64

    Note over start: 2. Effect.all(participants.map(resolveAgentToken))<br>name-shaped tokens fan out through Transport; UUID-shaped tokens<br>short-circuit client-side. Any failure → UnresolvedParticipantError → exit 64
    start->>tx: rpc(AgentsLookupByName, { names: ["bob"] }) (per name-shaped token)
    tx-->>start: { agents: [{ id, ... }] } or empty

    Note over start: 3. rpc(TaskCreate, {appId, invitedAgentIds, initialConversation})<br>initialConversation omits participants when invitedAgentIds.length === 0 (P2-B)
    start->>tx: TaskCreate
    tx-->>start: { task, conversation: Conversation | null }
    Note over start: failure → TransportError → exit 1<br>stdout: nothing

    alt conversation !== null (fresh create)
        Note over start: stdout: Task started: <taskId> (conversation: <convId>)
    else conversation === null (dedup hit — P2-A)
        Note over start: 3b. rpc(TaskConversationList, {limit, cursor?}) — follow nextCursor until match
        start->>tx: TaskConversationList
        tx-->>start: { items, nextCursor? }
        Note over start: findReusableConversation(taskId): pick first item where<br>item.taskId === existingTaskId AND item.conversation.archivedAt === undefined
        alt reusable conversation found
            Note over start: stdout: Task started: <taskId> (reusing existing conversation: <convId>)
        else no usable conversation (closed task, all archived, out of lookup window)
            Note over start: stderr: Task already exists but is closed: <taskId> → exit 1
        end
    end

    alt --message supplied AND a conversation is in hand
        Note over start: 4. rpc(MessagesSend, {conversationId: conv.id, parts:[{type:text,text}]})
        start->>tx: MessagesSend
        tx-->>start: { message }
        Note over start: success → stdout: Message sent: <msgId> → exit 0
        Note over start: failure → stderr: Error sending message: <err> → exit 2<br>(stdout already has Task started line)
    else --message omitted
        Note over start: exit 0
    end
```

## 4. Exit-code contract

| Code | Meaning | Stdout state | Stderr state |
|---|---|---|---|
| 0 | Full success (fresh create OR dedup hit with reusable conversation) | `Task started: …` (+ `Message sent: …` when `--message`) | empty |
| 1 | `TaskCreate` wire failure OR dedup hit on a closed/unreachable task (P2-A) | empty | `Failed: <err.message>` OR `Task already exists but is closed: <taskId>` |
| 2 | `TaskCreate` (or dedup reuse) OK, `MessagesSend` failed | `Task started: …` (no `Message sent`) | `Error sending message: <err.message>` |
| 64 | Usage error (bad `--app-id` UUID OR unresolvable agent token) | empty | `Invalid --app-id: not a UUID` OR `Cannot resolve "<token>": <reason>` |

NO rollback on exit 2: the task + empty conversation persist; user can
retry `moltzap send conv:<id> <text>` (Non-goal 3).

Exit code 64 matches POSIX `EX_USAGE` (sysexits.h) for script-friendly
discrimination between "your input was wrong" (64) and "the wire was
wrong" (1, 2).

## 5. Authority + identity

The command runs with the caller's identity per the global `--as` /
`--profile` flags — same precedence rules as `moltzap send` (see
[CLI Command Flow](./cli-command-flow.md) for the daemon-vs-direct
branch and the `transport.ts` selection logic). `TaskCreate` is open
to any authenticated agent (Spec D1 plan §"Authority matrix");
server-side contact-policy gating per
`requireContactPolicyForCreate` may reject the call with a
`TransportRpcError` mapped to exit 1.

## 6. Implementation sketch (impl-staff target)

The handler body is NOT in the stub. Impl-staff lands the following
shape (pseudocode; final Effect form may differ):

```ts
export const startCommandHandler = (args: StartCommandArgs) =>
  Effect.gen(function* () {
    // 1. Validate --app-id syntax
    const appId =
      args.appId !== undefined
        ? yield* validateAppId(args.appId)  // → InvalidAppIdError on bad UUID
        : DEFAULT_APP_ID;

    // 2. Resolve participants via the local Transport-routed helper.
    //    resolveAgentToken returns bare AgentId (NOT a participant ref),
    //    so no .map(p => p.id) step is needed. The helper itself maps
    //    shape failures + lookup-empty results to UnresolvedParticipantError.
    const invitedAgentIds = yield* Effect.all(
      args.participants.map(resolveAgentToken),
    );

    // 3. TaskCreate atomic
    const { task, conversation } = yield* rpc(TaskCreate, {
      appId,
      invitedAgentIds,
      initialConversation: { name: args.name, participants: invitedAgentIds },
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() => {
          // Exit 1: nothing printed yet, transport adapter prints stderr
        }),
      ),
    );

    if (conversation === null) {
      // D1 canary _C5 guarantees non-null when initialConversation sent;
      // defend against a stale D1 build with a decode-time exit 1.
      return yield* Effect.fail(
        new TransportDecodeError({ method: "task/create", cause: "missing conversation" }),
      );
    }

    yield* Effect.sync(() =>
      console.log(`Task started: ${task.id} (conversation: ${conversation.id})`),
    );

    // 4. Optional MessagesSend
    if (args.message !== undefined) {
      const sendResult = yield* rpc(MessagesSend, {
        conversationId: conversation.id,
        parts: [{ type: "text", text: args.message }],
      }).pipe(
        Effect.either,  // capture, don't propagate, so we can dispatch exit 2
      );
      if (Either.isLeft(sendResult)) {
        yield* Effect.sync(() => {
          console.error(`Error sending message: ${sendResult.left.message}`);
          process.exit(EXIT_CODE_PARTIAL_SUCCESS);
        });
        return;
      }
      yield* Effect.sync(() =>
        console.log(`Message sent: ${sendResult.right.message.id}`),
      );
    }
  });
```

### Partial-failure dispatcher — canonical contract

The shared `runHandler(...)` adapter in `transport.ts` maps every
caught error to exit code 1 unconditionally. D2 needs three non-default
exit codes (2, 64, plus 0/1) keyed on the stage where the error
arose. Architect picks a **hybrid two-stage dispatcher**, codified in
the stub (`start.ts → runStartCommand` + `start.ts →
startCommandHandler`):

- **`runStartCommand(effect)`** is the outer adapter (replaces
  `runHandler` in the `Command.make` wrapper). It pattern-matches the
  caught `StartCommandError` on `_tag` and dispatches:
  - `InvalidAppIdError` → `process.exit(EXIT_CODES.USAGE_ERROR)` + stderr `Invalid --app-id: not a UUID`
  - `UnresolvedParticipantError` → `process.exit(EXIT_CODES.USAGE_ERROR)` + stderr `Cannot resolve "<token>": <reason>`
  - any other `StartCommandError` (the `TransportError` union from
    `transport.ts`, including `TransportRpcError`,
    `TransportDecodeError`, `ServiceUnreachableError`, etc.) →
    `process.exit(EXIT_CODES.TASK_CREATE_FAILED)` + stderr
    `Failed: <err.message>`
- **Inline `process.exit(EXIT_CODES.PARTIAL_SUCCESS)`** inside the
  handler body for the post-`TaskCreate` `MessagesSend` failure. This
  path cannot route through `runStartCommand` because the stdout
  `Task started: ...` line has already been printed; re-throwing the
  error and letting `runStartCommand` dispatch would discard the
  successful task creation from the user's view. The handler uses
  `Effect.either(rpc(MessagesSend, ...))` to catch in-band, then
  `Effect.sync(() => { console.error(...); process.exit(2); })`.

This split is the architect-locked contract. Impl-staff implements
both halves (the `Effect.catchAll` body of `runStartCommand` and the
`Effect.either` branch of the handler); `/simplify` review may
re-examine the partition but the exit-code-by-stage contract is fixed
by the spec D2 ACs.

Test-side: `process.exit = vi.fn() as never` (per `register.test.ts`
pattern); assert `expect(process.exit).toHaveBeenCalledWith(64)` /
`...(2)` / `...(1)` per scenario.

### Why we don't reuse `resolveParticipant`

`socket-client.ts → resolveParticipant` is the helper today's
`commands/conversations.ts → createConversation` uses. It returns
`{ type: "agent", id: AgentId }` after a server lookup via
`socket-client.ts → request(AgentsLookupByName, ...)`. D2 does NOT
reuse it. Reasons:

1. **Transport mismatch.** `socket-client.ts → request` hard-wires
   the daemon-socket path (`MoltZapService.SOCKET_PATH`). D2's
   `TaskCreate` and `MessagesSend` calls go through
   `transport.ts → rpc(...)` (the `Transport` Effect service),
   which is selected by `cli/index.ts → moltzapBase` from `--as` /
   `--profile` / daemon precedence. A `moltzap --as <key> start
   ... agent:bob ...` invocation would resolve `bob` through the
   daemon socket (potentially unreachable) but call `TaskCreate`
   through direct-WS — a confusing split.
2. **Testability.** `commands/test-transport.ts → makeFakeTransport`
   intercepts `Transport.rpc` calls. It cannot intercept the
   daemon-socket path. Spec D2 ACs require unit tests that mock
   `AgentsLookupByName`'s response (empty vs. populated) to drive
   the resolution-failure branch. Without a transport-routed
   resolver, this test is not implementable cleanly.
3. **Wire-shape match.** D2's `TaskCreate.initialConversation.participants`
   is `Array(AgentId)` (Spec D1 canary `_L1..L3`), not
   `agentParticipantRefSchema[]`. The local resolver returns bare
   `AgentId` directly, eliminating a `.map(p => p.id)` step.

D2 introduces `start.ts → resolveAgentToken` (transport-routed
sibling): parses `agent:<rest>` and either short-circuits if `rest`
is a UUID v4 or calls `rpc(AgentsLookupByName, { names: [rest] })`.
On empty result → `UnresolvedParticipantError({ token, reason:
"not-found" })`. On shape failure (no `agent:` prefix, etc.) →
`UnresolvedParticipantError({ token, reason: "shape" })`.

`commands/conversations.ts` keeps using `resolveParticipant`
unchanged (Non-goal 1). D3 may consolidate when the legacy command
deletes.

## 7. Test alignment

Spec D2 acceptance criteria → test files:

| AC | Test file | Strategy |
|---|---|---|
| RPC payload assertions | `start.test.ts` | `makeFakeTransport` records `{method, params}`; assert `TaskCreate` and `MessagesSend` payloads against parsed CLI args |
| Participant model: `length === 1` | `start.test.ts > dm-shape` | fixture: one `agent:` token → assert `invitedAgentIds.length === 1` |
| Participant model: `length >= 2` | `start.test.ts > group-shape` | fixture: two `agent:` tokens → assert `invitedAgentIds.length === 2` and order preserved |
| Caller NOT in `invitedAgentIds` | `start.test.ts > caller-excluded` | assert caller's own `AgentId` does NOT appear in `params.invitedAgentIds` |
| Output strings | `start.test.ts > output-format` | `console.log` spy; assert exact strings incl. `Task started: <id> (conversation: <id>)` and `Message sent: <id>` |
| `--app-id` default | `start.test.ts > default-app-id` | omit `--app-id` flag; assert recorded `params.appId === DEFAULT_APP_ID` (imported from `@moltzap/protocol`) |
| `--app-id` invalid UUID | `start.test.ts > invalid-app-id` | pass `--app-id not-a-uuid`; assert exit 64, stderr `Invalid --app-id: not a UUID`, zero recorded RPC calls |
| `--app-id` server reject | `start.test.ts > server-reject-app-id` | mock transport returns `TransportRpcError`; assert exit 1, stderr has error |
| Partial failure | `start.test.ts > partial-success` | `TaskCreate` success + `MessagesSend` fail → assert stdout has `Task started:` line, stderr `Error sending message:`, exit 2 |
| Unresolved participant | `start.test.ts > unresolved-participant` | `AgentsLookupByName` returns empty agents; assert exit 64, stderr names the token, ZERO `TaskCreate` / `MessagesSend` calls |
| Help text | `start.test.ts > help` | snapshot `moltzap start --help`; assert presence of synopsis, `--message`, `--app-id`, and the four exit codes |
| **Dedup hit, single conversation** (P2-A) | `start.test.ts > dedupHitSingleConversation` | `TaskCreate` returns `{ task: existing, conversation: null }`; `TaskConversationList` returns one matching item; assert stdout `Task started: <id> (reusing existing conversation: <id>)` |
| **Dedup hit, multiple conversations** (P2-A tie-break) | `start.test.ts > dedupHitMultipleConversations` | server-order first match wins (most-recently-active) |
| **Dedup hit + `--message`** (P2-A reuse-conv MessagesSend route) | `start.test.ts > dedupHitWithMessage` | `MessagesSend.params.conversationId === existing.conversation.id` |
| **Dedup hit, filtering** (P2-A taskId + archivedAt filter) | `start.test.ts > dedupHitFiltersOtherTaskAndArchived` | items from other tasks AND `archivedAt !== undefined` items are skipped |
| **Dedup hit, closed task** (P2-A no-usable-conv branch) | `start.test.ts > dedupHitTaskClosedNoUsableConversation` | `findReusableConversation` returns null → stderr `Task already exists but is closed: <taskId>` + exit 1 |
| **Dedup hit, pagination** (P2-A cursor follow) | `start.test.ts > dedupHitPaginatesUntilFound` | first page has no match → follow `nextCursor` until found |
| **Zero-participant wire shape** (P2-B carve-out) | `start.test.ts > zeroParticipants` | `TaskCreate.params.initialConversation` deep-equals `{ name }` (no `participants` key) |
| CHANGELOG | (manual review at PR time) | grep root `CHANGELOG.md` `[Unreleased]` for the new-command entry |

Test infra reuses `makeFakeTransport(...)` from
`commands/test-transport.ts`. Helpers `vi.spyOn(console, "log")` and
`process.exit = vi.fn() as never` match the pattern in
`register.test.ts` and `send.test.ts`. CLI commands run via
`startCommand.handler({...})` with `Effect.provideService(Transport,
fakeTransport)`.

For the `AgentsLookupByName` mock: `makeFakeTransport`'s `respond`
callback returns an `{ agents: [...] }` shape for the lookup method;
empty array drives the "unresolved" failure. Daemon-socket path is
NOT exercised by unit tests — they use `Transport` directly.

## 8. Concerns from D1 dependency

- **`TaskCreate` from `@moltzap/protocol` is not yet on `main`.** D1 stub
  lives at `architect/598-task-conversation` @ `bc913ba` (plan #635
  plan-approved); the descriptor + brand + constant land in the
  package only when D1 impl-staff (HARD-blocked on Spec E Phase 1)
  merges. D2's impl-staff PR therefore depends on D1's impl-staff PR
  landing first — orchestrator should sequence D2 impl AFTER D1 impl,
  not concurrent. The architect plan + stub are unblocked (this
  branch).
- **Spec D2 AC interpretation: "NO RPC calls" reads as "no mutating
  RPC calls".** `start.ts → resolveAgentToken` calls
  `rpc(AgentsLookupByName, ...)` for name-shaped tokens (a server
  RPC), which the strict reading of the AC would prohibit. Architect
  interpretation: the AC means "NO `TaskCreate` / `MessagesSend`
  calls", since only those two are spec-D2's mutating calls. The
  read-only lookup is intentional + necessary (UUID-only tokens are
  the only alternative and would break the `agent:&lt;name>`
  shorthand). Re-confirmed in r2 N=2 review.

## 9. Cold-start reading order

A consumer wanting to understand the `moltzap start` command in the
fewest hops:

1. Read this doc (you are here).
2. Read [CLI Command Flow](./cli-command-flow.md) for the
   identity/transport machinery the command inherits (`--as`,
   `--profile`, daemon vs direct).
3. Read [Error Taxonomy](./error-taxonomy.md) for the
   `TransportError` shape that the partial-failure dispatcher branches
   on.
4. Read D1 per-flow doc
   `packages/protocol/docs/architecture/12-task-conversation-family.md`
   for the `TaskCreate` semantics: appId-only, dedup behavior, and
   the `conversation: Conversation | null` result shape.
5. Read Spec D2 body (#599) for the acceptance criteria and the
   partial-failure / exit-code contract verbatim.
