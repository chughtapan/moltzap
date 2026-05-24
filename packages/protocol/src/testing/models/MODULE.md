# protocol/testing/models

_`packages/protocol/src/testing/models`_

## Purpose

Public barrel for protocol reference-model helpers.

## Public surface

### [`applyCall`](./dispatch.ts#L202)

_Function_

```ts
}

function modelOutcome(kind: ModelMethodOutcome): RpcModelResult
```

Pure reducer: given state + call, yield the next state and the
observable outcome. No I/O. No clocks. No exceptions — every failure
flows through `_tag: "error"`.

Exhaustiveness: the `switch` has a branch for every method name in
`rpcMethods`. A missing branch becomes a compile error at `absurd`.
Behaviour is intentionally conservative — the model predicts the
server's *observable* outcome (success vs typed error), not its full
result shape. Tier B canonicalizers downgrade server responses to the
same projection before comparing.

### [`authorizationOutcome`](./dispatch.ts#L155)

_Function_

```ts
      return "deny-forbidden"
```

Authorization oracle (B2 / B3). Returns the expected typed outcome for a
call made by `agentId`. Property code compares the real server's error
to this.

Rules (mirrored from `packages/server/src/app/authz.ts` contract):
  - Unregistered agent + non-connect method → deny-unauthenticated.
  - Conversation-scoped method + `authz` entry "denied" → deny-forbidden.
  - Otherwise allow.

### [`initialReferenceState`](./state.ts#L53)

_Variable_

```ts
export const initialReferenceState: ReferenceState =
```

### [`isIdempotent`](./dispatch.ts#L102)

_Function_

```ts
  [Register.name]: "uncertain",
  [InviteAgent.name]: "uncertain",
  [AgentsList.name]: "ok",
  [NetworkPing.name]: "ok",
  [AgentsLookup.name]: "uncertain",
  [AgentsLookupByName.name]: "uncertain",
  [TaskConversationList.name]: "uncertain",
  [TaskConversationCreate.name]: "uncertain",
  [TaskConversationArchive.name]: "uncertain",
  [TaskConversationUnarchive.name]: "uncertain",
  [TaskAddParticipant.name]: "uncertain",
  [TaskLeave.name]: "uncertain",
  [MessagesSend.name]: "uncertain",
  [MessagesList.name]: "uncertain",
  [ContactsList.name]: "uncertain",
  [ContactsAdd.name]: "uncertain",
  [ContactsAccept.name]: "uncertain",
  [ContactsById.name]: "uncertain",
  [InvitesCreateAgent.name]: "uncertain",
  [PresenceUpdate.name]: "uncertain",
  [PresenceSubscribe.name]: "uncertain",
  [AppsRegister.name]: "uncertain",
  [DispatchRequest.name]: "uncertain",
  [DispatchesGet.name]: "uncertain",
  [TaskRequest.name]: "uncertain",
  [TaskList.name]: "uncertain",
  [TaskClose.name]: "uncertain",
} as const satisfies Readonly<Record<MethodName, ModelMethodOutcome>>
```

### [`LogicalTick`](./state.ts#L22)

_TypeAlias_

```ts
export type LogicalTick = number & Brand.Brand<"LogicalTick">;
```

Monotonic logical clock — the model does not read wall time.

### [`mkTick`](./state.ts#L26)

_Function_

```ts
export function mkTick(n: number): LogicalTick
```

Construct a `LogicalTick` from a raw number. Only call in this module.

### [`ReferenceState`](./state.ts#L31)

_Interface_

```ts
export interface ReferenceState {
  readonly tick: LogicalTick;
  /** Registered agents, keyed by `agentId`. */
  readonly agents: ReadonlyMap<AgentId, Agent>;
  /** Conversations, keyed by `conversationId`. */
  readonly conversations: ReadonlyMap<ConversationId, Conversation>;
  /** Messages per conversation, append-only, ordered. */
  readonly messages: ReadonlyMap<ConversationId, ReadonlyArray<Message>>;
  /** Per-agent outbox of events the model predicts the server will emit. */
  readonly pendingEvents: ReadonlyMap<
    AgentId,
    ReadonlyArray<NotificationFrame>
  >;
  /** Authorization table — (agentId, conversationId) → role. */
  readonly authz: ReadonlyMap<
    AgentId,
    ReadonlyMap<ConversationId, "owner" | "participant" | "denied">
  >;
  /** Request-ids the model has observed, for uniqueness assertions (B4). */
  readonly seenRequestIds: ReadonlySet<string>;
}
```

Every kind of entity the model tracks.

### [`RpcModelResult`](./dispatch.ts#L71)

_TypeAlias_

```ts
  | {
      readonly _tag: "error";
      readonly code: number;
      readonly message: string;
      readonly events: ReadonlyArray<NotificationFrame>;
    };
```

Observable outcome of one RPC against the model, in the same shape the
real server puts on the wire. Tier B's B1 asserts
`deepEqual(serverResponse, modelResponse)` modulo opaque fields (IDs,
tokens — extracted to a named canonicalizer in the implementer step).

## Files

- `dispatch.ts`
- `state.ts`
