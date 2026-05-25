# protocol/app

_`packages/protocol/src/app`_

## Purpose

Public barrel for app RPC descriptors and app-hook protocol types.

## Public surface

### [`AppManifest`](./methods.ts#L97)

_TypeAlias_

```ts
export type AppManifest = Static<typeof AppManifestSchema>;
```

### [`AppManifestValidationResult`](./methods.ts#L113)

_TypeAlias_

```ts
export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;
```

### [`appNotifications`](./methods.ts#L594)

_Variable_

```ts
export const appNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const
```

### [`appRpcMethods`](./methods.ts#L582)

_Variable_

```ts
export const appRpcMethods = [
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
] as const
```

### [`AppsRegister`](./methods.ts#L141)

_Variable_

```ts
export const AppsRegister = defineRpc({
  name: "apps/register",
  params: Type.Object(
    { manifest: AppManifestSchema },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { appId: Type.String() },
    { additionalProperties: false },
  ),
})
```

Register an app manifest for the current connection.

### [`DispatchAuthorize`](./methods.ts#L281)

_Variable_

```ts
export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: DispatchAuthorizeContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
})
```

Server → moderator request asking for the admission verdict. Carried
inside the forked moderator round-trip; failure / timeout in the
round-trip synthesizes a fail-closed `deny` verdict at
`LeaseRegistry.resolve`. Manifests opt in by declaring
`hooks.dispatch_authorize`.

### [`DispatchesConsumed`](./methods.ts#L324)

_Variable_

```ts
export const DispatchesConsumed = defineNotification({
  name: "dispatches/consumed",
  params: Type.Object(
    {
      dispatchId: DispatchId,
      leaseId: LeaseId,
      conversationId: ConversationId,
      messageId: MessageId,
      consumedAt: DateTimeString,
    },
    { additionalProperties: false },
  ),
})
```

Server → moderator notification: a lease was consumed by a
successful `messages/send`. Fires at `Claim.finalize` time, after
the durable insert lands, scoped to the moderator's connection only
(NOT broadcast). The moderator IS the authority for the lease, so
`messageId` visibility is in-scope.

### [`DispatchesExpired`](./methods.ts#L344)

_Variable_

```ts
export const DispatchesExpired = defineNotification({
  name: "dispatches/expired",
  params: Type.Object(
    {
      dispatchId: DispatchId,
      leaseId: LeaseId,
      conversationId: ConversationId,
      expiredAt: DateTimeString,
    },
    { additionalProperties: false },
  ),
})
```

Server → moderator notification: a granted lease aged out via post-
grant TTL without being consumed. Scoped to the moderator's
connection only. Distinct from DENIED (verdict-deny) and ABANDONED
(recipient disconnect) — EXPIRED is the inactivity outcome.

### [`DispatchesGet`](./methods.ts#L404)

_Variable_

```ts
export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Type.Object(
    { dispatchId: DispatchId },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { lease: LeaseRecordSchema },
    { additionalProperties: false },
  ),
})
```

Moderator-only query for a specific lease record. Scope-enforced at
the handler: the calling connection must match the lease's
`moderatorConnectionId` (the binding tuple recorded at mint time);
non-moderator callers fail with `ForbiddenError`.

### [`DispatchId`](./methods.ts#L239)

_TypeAlias_

```ts
export const DispatchId = brandedId("DispatchId");
```

Branded dispatch identifier minted alongside the lease. Distinct from
the lease id so observability surfaces (`dispatches/get`,
`dispatches/consumed`, `dispatches/expired`) can reference an
admission attempt by a stable handle whose lease may have been
rolled back-and-re-granted within the same dispatch.

### [`DispatchId`](./methods.ts#L239)

_Variable_

```ts
export const DispatchId = brandedId("DispatchId")
```

Branded dispatch identifier minted alongside the lease. Distinct from
the lease id so observability surfaces (`dispatches/get`,
`dispatches/consumed`, `dispatches/expired`) can reference an
admission attempt by a stable handle whose lease may have been
rolled back-and-re-granted within the same dispatch.

### [`DispatchRelease`](./methods.ts#L302)

_Variable_

```ts
export const DispatchRelease = defineNotification({
  name: "dispatch/release",
  params: Type.Object(
    {
      dispatchId: DispatchId,
      leaseId: LeaseId,
      verdict: DispatchAdmissionDecisionSchema,
      leaseTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
})
```

Server → recipient verdict notification. Fire-and-forget on the wire
(Final Decision #2). Always emitted, including default-grant and
synthesized infra-hold (Final Decisions #3, #10). The recipient parks
client-side on `leaseId` and unparks on this notification.

`leaseTimeoutMs` is set on the `grant` arm only and is the post-
grant TTL (Final Decision #9). HOLD inherits the same TTL by ageing
out via the standard EXPIRED path; no `leaseTimeoutMs` field needed
on the hold arm because the grant TTL has not started yet (lease
never reached GRANTED).

### [`DispatchRequest`](./methods.ts#L251)

_Variable_

```ts
export const DispatchRequest = defineRpc({
  name: "dispatch/request",
  params: Type.Object(
    {
      conversationId: ConversationId,
      messageId: MessageId,
      senderAgentId: AgentId,
      parts: Type.Optional(MessagePartsSchema),
      receivedAt: Type.Optional(DateTimeString),
      pending: Type.Optional(PendingMessageArraySchema),
      clock: Type.Optional(LogicalClockSchema),
      attempt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { leaseId: LeaseId, dispatchId: DispatchId },
    { additionalProperties: false },
  ),
})
```

Recipient → server admission request. The server returns an
immediate ack carrying `{leaseId, dispatchId}` and emits an out-of-
band `dispatch/release` notification carrying the verdict.

Wire ordering: the ack and `dispatch/release` may race — the
recipient absorbs the race via a client-side ring buffer + per-
lease `Deferred` (see `packages/client/src/channel-core.ts`).

### [`MessagesAuthorize`](./methods.ts#L482)

_Variable_

```ts
export const MessagesAuthorize = defineRpc({
  name: "messages/authorize",
  params: MessagesAuthorizeContextSchema,
  result: Type.Object(
    { verdict: MessagesAuthorizeVerdictSchema },
    { additionalProperties: false },
  ),
})
```

Server → TM round-trip asking for the per-message fan-out verdict.
Triggered from `MessageService.sendCommit` after the durable insert
lands and before the broadcast. Manifests opt in by declaring
`hooks.message_authorize`. Failure / timeout in the round-trip
synthesizes a fail-closed `Block { reason: "tm_unreachable" }`
verdict at the AppHost envelope (mirrors `runAuthorizeDispatch`'s
`wrapHookEffectWithEnvelope` posture).

`Forward { recipients }` MUST be a subset of the conversation's
participants; the server does not re-fan to non-participants.
`Forward { recipients: [] }` is legal — message lands in the
sender's transcript but is delivered to no one else.

### [`taskCallbackMethods`](./methods.ts#L588)

_Variable_

```ts
export const taskCallbackMethods = [
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
] as const
```

### [`TaskCreate`](./methods.ts#L571)

_Variable_

```ts
export const TaskCreate = defineRpc({
  name: "task/create",
  params: TaskCreateContextSchema,
  result: Type.Object(
    { verdict: TaskCreateVerdictSchema },
    { additionalProperties: false },
  ),
})
```

Server → TM round-trip asking whether the TM accepts a newly
requested task. Triggered from the `task/request` handler after
the task row is inserted (status `"waiting"`) and before the
requester observes any state.

The TM owns the post-accept lifecycle:
  - On `accept` the server transitions the task to `"active"`
    and fires `task/created` to the requester. The TM SHOULD
    then call `task/conversation/create` to honor the
    requester's `initialConversation` hint if it chose to.
  - On `reject` (or timeout / RPC error / decode failure) the
    server transitions the task to `"failed"` and fires
    `task/failed` to the requester.

Fail-closed envelope mirrors `DispatchAuthorize` /
`MessagesAuthorize`: timeout synthesizes
`{ decision: "reject", reason: "timeout" }`; an unknown app or
RPC/decode failure synthesizes `reason: "tm_unreachable"`.

Durability note: the `task/request` handler inserts the task row
(`waiting`) BEFORE this callback's network round-trip, and the
terminal `setStatus` runs AFTER it. The sequence is not atomic
(the callback is a network call, not a DB op), so a crash or fiber
interrupt in that window can strand a task in `waiting`. Stranded
waiting tasks are invisible to delivery (no conversation, no
participants observe them) and are reaped by follow-up work (the
stale-waiting-task sweep, #684).

### [`validateAppManifest`](./methods.ts#L130)

_Function_

```ts
export function validateAppManifest(
  value: unknown,
): AppManifestValidationResult
```

## Files

- `methods.ts`
