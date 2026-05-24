# @moltzap/server

Server package — extends the workspace-root `/home/tapanc/moltzap/CLAUDE.md`
(architecture-doc rules, LSP-first tracing, symbol-name citations,
Mermaid gotchas all inherited).

## Architecture entry points

- **`ARCHITECTURE.md`** — package-level index. §3 Communication Flows
  table links to per-flow detail docs under `docs/architecture/`.
- **`docs/architecture/NN-<topic>.md`** — per-flow detail docs. Update
  the matching detail doc in the same PR that changes the flow.

When you change request routing, dispatcher logic, lifecycle, or a
service's authority surface, the relevant detail doc is the
single-source-of-truth diagram for that flow; the doc is wrong the
moment the code drifts from it.

## R-channel capability tokens

Privileged service methods declare their preconditions in their
type signature via Effect's R channel. The descriptor declares which
capability tags the handler needs; the dispatcher auto-provisions
them per frame from a shared provider table — handlers `yield*` the
tag directly with no hand-piped `Effect.provideServiceEffect` chain
at the call site.

```ts
// protocol/task/tasks.ts — descriptor declares its capabilities
export const TaskConversationCreate = defineRpc({
  name: "task/conversation/create",
  params: TaskConversationCreateParams,
  result: TaskConversationCreateResult,
  capabilities: [
    { tag: TmAuthority,                    argsOf: (p, ctx) => ({ taskId: p.taskId, callerAgentId: ctx.auth.agentId }) },
    { tag: ConversationCreateAuthorization, argsOf: (p, ctx) => ({ agentIds: [...p.participants], creatorAgentId: ctx.auth.agentId }) },
  ],
});

// service body just yields the tag, no provideServiceEffect at the call site
create(
  /* ... */
): Effect.Effect<Conversation, ConversationServiceError, ConversationCreateAuthorization>;

// server/src/app/capability-providers.ts — single source of truth.
// Simple obtains are INLINE here (each has exactly one consumer: this
// table). TmAuthority keys off the WS connection id (#673 app-ownership
// model), not the agent id.
export const serverCapabilityProviders = {
  [TmAuthority.key]: (args) =>
    Effect.gen(function* () {
      const taskService = yield* TaskServiceTag;
      const appHost = yield* AppHostTag;
      const { taskId, callerConnId } = args as TaskAndConn;
      const task = yield* taskService.loadOpenTask(taskId);
      if (!appHost.isAppConnection(Value.Decode(AppId, task.appId), callerConnId)) {
        return yield* Effect.fail(new ForbiddenError({ message: "..." }));
      }
      return { task };
    }),
  /* ...TaskReadAccess, ConversationInTask, ContactPolicyAllowsReach inline... */
  // Composites with their own direct consumers live as named functions
  // next to the services they compose:
  [ConversationCreateAuthorization.key]: (args) =>
    obtainConversationCreateAuthorization(args), // task/services/conversation-create-authorization.ts
  [MessageSendPermission.key]: (args) =>
    obtainMessageSendPermission(args), // task/services/message-send-permission.ts
} as const;
```

The dispatcher reads `definition.capabilities` per frame, looks up
each tag's obtain helper in `serverCapabilityProviders`, and threads
`Effect.provideServiceEffect(tag, providerEffect)` over the handler
before invoking it. The compile-time lockstep gate
(`protocol/transport/typed-dispatcher.types-check.ts` Canary 7)
rejects any handler whose R channel references a tag NOT in its
descriptor's `capabilities` array.

`MessagesSend` is the one structural exception: the wire schema
accepts `(conversationId | to | replyToId)` and the handler must
resolve `conversationId` via DB lookup before `MessageSendPermission`
can be obtained, so it stays hand-piped at the handler call site.
See `protocol/task/messages.ts → MessagesSend` for the rationale.

- **`packages/server/docs/architecture/r-channel-capabilities.md`**
  — pattern overview, when to add a capability, refine-shape vs
  obtain-shape, composite vs union-of-tags, migration recipe, and
  bug-class explainer.

Capability shapes:

- **Obtain** — queries the DB, produces the capability value + payload
  row. `obtainXxx(...)` returns `Effect<Xxx["Type"], ServiceError, ServiceTag>`.
- **Refine** — validates an already-fetched row (no DB read).
  `refineXxx(row)` returns `Effect<Xxx["Type"], ValidationError>`. The
  refine helpers (`refineTaskActive`, `refineConversationNotArchived`)
  live in `@moltzap/protocol/task/capabilities`.
- **Composite** — collapses an intersection-with-alternative
  authorization set into one tag whose value is a discriminated union,
  because Effect's R channel cannot express "exactly one of N
  alternative tags must be provided" (architect Decision A, #606).
  `MessageSendPermission` is the canonical composite.

When you add a new capability tag, the tag class + value type live in
`packages/protocol/src/task/capabilities/<name>.ts` (so descriptors can
reference them without a layering violation). The obtain logic lives in
`server/src/app/capability-providers.ts`: inline in the provider-table
entry for a simple obtain, or as a named function in
`server/src/task/services/<name>.ts` for a composite that has its own
direct consumer (currently `obtainMessageSendPermission` and
`obtainConversationCreateAuthorization`). Capability tags are collected
by the `CapabilityTags` alias in `transport/layer-tags.ts`;
`defineTaskMethod` / `defineAppMethod` accept them in the handler R
channel so the dispatcher's auto-provision path can fill them from the
descriptor's `capabilities` array.

## Layered RPC method wrappers

`src/transport/define-layered-method.ts` exports `defineNetworkMethod`,
`defineTaskMethod`, `defineAppMethod`. Each wrapper enforces a
per-layer Tag allowlist (`NetworkTags` ⊂ `TaskTags` ⊂ `AppTags`) so a
handler at layer L cannot pull a service that only layer L+1 owns.
See `transport/README.md` for the layer hierarchy and
`transport/layer-tags.ts` for the allowlists (capability tags are a
sibling alias, NOT folded in).
