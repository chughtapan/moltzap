# protocol/app

_`packages/protocol/src/app`_

## Purpose

Public barrel for app RPC descriptors and app-hook protocol types.

## Public surface

### [`appCallbackMethods`](./methods.ts#L500)

_Variable_

```ts
export const appCallbackMethods = [
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
] as const
```

### [`AppManifest`](./methods.ts#L82)

_TypeAlias_

```ts
export type AppManifest = Schema.Schema.Type<typeof AppManifestSchema>;
```

### [`AppManifestValidationResult`](./methods.ts#L90)

_TypeAlias_

```ts
export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;
```

### [`appNotifications`](./methods.ts#L506)

_Variable_

```ts
export const appNotifications = [
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
] as const
```

### [`appRpcMethods`](./methods.ts#L494)

_Variable_

```ts
export const appRpcMethods = [
  AppsRegister,
  DispatchRequest,
  DispatchesGet,
] as const
```

### [`AppsRegister`](./methods.ts#L123)

_Variable_

```ts
export const AppsRegister = defineRpc({
  name: "apps/register",
  params: Schema.Struct({ manifest: AppManifestSchema }),
  result: Schema.Struct({ appId: Schema.String }),
})
```

Register an app manifest for the current connection.

### [`DispatchAuthorize`](./methods.ts#L237)

_Variable_

```ts
export const DispatchAuthorize = defineRpc({
  name: "dispatch/authorize",
  params: DispatchAuthorizeContextSchema,
  result: Schema.Struct({ admission: DispatchAdmissionDecisionSchema }),
})
```

Server → moderator request asking for the admission verdict. Carried
inside the forked moderator round-trip; failure / timeout in the
round-trip synthesizes a fail-closed `deny` verdict at
`LeaseRegistry.resolve`. Manifests opt in by declaring
`hooks.dispatch_authorize`.

### [`DispatchesConsumed`](./methods.ts#L276)

_Variable_

```ts
export const DispatchesConsumed = defineNotification({
  name: "dispatches/consumed",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    messageId: MessageId,
    consumedAt: DateTimeString,
  }),
})
```

Server → moderator notification: a lease was consumed by a
successful `messages/send`. Fires at `Claim.finalize` time, after
the durable insert lands, scoped to the moderator's connection only
(NOT broadcast). The moderator IS the authority for the lease, so
`messageId` visibility is in-scope.

### [`DispatchesExpired`](./methods.ts#L293)

_Variable_

```ts
export const DispatchesExpired = defineNotification({
  name: "dispatches/expired",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    conversationId: ConversationId,
    expiredAt: DateTimeString,
  }),
})
```

Server → moderator notification: a granted lease aged out via post-
grant TTL without being consumed. Scoped to the moderator's
connection only. Distinct from DENIED (verdict-deny) and ABANDONED
(recipient disconnect) — EXPIRED is the inactivity outcome.

### [`DispatchesGet`](./methods.ts#L350)

_Variable_

```ts
export const DispatchesGet = defineRpc({
  name: "dispatches/get",
  params: Schema.Struct({ dispatchId: DispatchId }),
  result: Schema.Struct({ lease: LeaseRecordSchema }),
})
```

Moderator-only query for a specific lease record. Scope-enforced at
the handler: the calling connection must match the lease's
`moderatorConnectionId` (the binding tuple recorded at mint time);
non-moderator callers fail with `ForbiddenError`.

### [`DispatchId`](./methods.ts#L199)

_TypeAlias_

```ts
export const DispatchId = brandedId("DispatchId");
```

Branded dispatch identifier minted alongside the lease. Distinct from
the lease id so observability surfaces (`dispatches/get`,
`dispatches/consumed`, `dispatches/expired`) can reference an
admission attempt by a stable handle whose lease may have been
rolled back-and-re-granted within the same dispatch.

### [`DispatchId`](./methods.ts#L199)

_Variable_

```ts
export const DispatchId = brandedId("DispatchId")
```

Branded dispatch identifier minted alongside the lease. Distinct from
the lease id so observability surfaces (`dispatches/get`,
`dispatches/consumed`, `dispatches/expired`) can reference an
admission attempt by a stable handle whose lease may have been
rolled back-and-re-granted within the same dispatch.

### [`DispatchRelease`](./methods.ts#L255)

_Variable_

```ts
export const DispatchRelease = defineNotification({
  name: "dispatch/release",
  params: Schema.Struct({
    dispatchId: DispatchId,
    leaseId: LeaseId,
    verdict: DispatchAdmissionDecisionSchema,
    leaseTimeoutMs: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
    ),
  }),
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

### [`DispatchRequest`](./methods.ts#L211)

_Variable_

```ts
export const DispatchRequest = defineRpc({
  name: "dispatch/request",
  params: Schema.Struct({
    conversationId: ConversationId,
    messageId: MessageId,
    senderAgentId: AgentId,
    parts: Schema.optional(MessagePartsSchema),
    receivedAt: Schema.optional(DateTimeString),
    pending: Schema.optional(PendingMessageArraySchema),
    clock: Schema.optional(LogicalClockSchema),
    attempt: Schema.optional(
      Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
    ),
  }),
  result: Schema.Struct({ leaseId: LeaseId, dispatchId: DispatchId }),
})
```

Recipient → server admission request. The server returns an
immediate ack carrying `{leaseId, dispatchId}` and emits an out-of-
band `dispatch/release` notification carrying the verdict.

Wire ordering: the ack and `dispatch/release` may race — the
recipient absorbs the race via a client-side ring buffer + per-
lease `Deferred` (see `packages/client/src/channel-core.ts`).

### [`MessagesAuthorize`](./methods.ts#L410)

_Variable_

```ts
export const MessagesAuthorize = defineRpc({
  name: "messages/authorize",
  params: MessagesAuthorizeContextSchema,
  result: Schema.Struct({ verdict: MessagesAuthorizeVerdictSchema }),
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

### [`TaskCreate`](./methods.ts#L486)

_Variable_

```ts
export const TaskCreate = defineRpc({
  name: "task/create",
  params: TaskCreateContextSchema,
  result: Schema.Struct({ verdict: TaskCreateVerdictSchema }),
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

### [`validateAppManifest`](./methods.ts#L102)

_Function_

```ts
export function validateAppManifest(
  value: unknown,
): AppManifestValidationResult
```

Strict manifest validation. Decodes with `{ onExcessProperty: "error" }`
(the former `new Ajv({ strict: true })` + `additionalProperties:false`
rejected extra keys); on failure surfaces every `ParseError` leaf via
`ParseResult.ArrayFormatter.formatErrorSync` (one issue → one string),
replacing the AJV `.errors` `${instancePath} ${message}` adapter.

## Files

- `methods.ts`
