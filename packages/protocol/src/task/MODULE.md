# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for the opaque task label and the app send-hook failure.

## Public surface

### [`HookBlockedError`](./hooks.ts#L14)

_Class_

```ts
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}
```

The app that authorizes a conversation refused the dispatch. Raised by
`agent/message/send` when the app's send hook returns a block verdict (or the
fail-closed envelope synthesizes one on timeout, RPC error, or decode
failure). The app's reason rides in the `data` arm when present.

### [`taskId`](./ids.ts#L10)

_Variable_

```ts
export const taskId: Schema.Schema<TaskId, string> = formatString("uuid").pipe(
  Schema.brand("TaskId"),
  Schema.annotations({ description: "Branded TaskId" }),
)
```

Validates and decodes task id values.

### [`TaskId`](./ids.ts#L8)

_TypeAlias_

```ts
export type TaskId = string & Brand.Brand<"TaskId">;
```

Opaque endpoint label a caller may pin to a message or conversation. The
server carries and echoes it without interpretation.

## Files

- `hooks.ts`
- `ids.ts`
