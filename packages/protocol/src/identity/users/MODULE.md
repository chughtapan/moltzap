# protocol/identity/users

_`packages/protocol/src/identity/users`_

## Purpose

User identity identifiers.

## Public surface

### [`userId`](./ids.ts#L8)

_Variable_

```ts
export const userId: Schema.Schema<UserId, string> = formatString("uuid").pipe(
  Schema.brand("UserId"),
  Schema.annotations({ description: "Branded UserId" }),
)
```

Validates and decodes user id values.

### [`UserId`](./ids.ts#L6)

_TypeAlias_

```ts
export type UserId = string & Brand.Brand<"UserId">;
```

Represents user id values.

## Files

- `ids.ts`
