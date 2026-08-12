# protocol/identity/users

_`packages/protocol/src/identity/users`_

## Purpose

User identity identifiers.

## Public surface

### [`userId`](./index.ts#L11)

_Variable_

```ts
export const userId: Schema.Schema<UserId, string> = formatString("uuid").pipe(
  Schema.brand("UserId"),
  Schema.annotations({ description: "Branded UserId" }),
)
```

Validates and decodes user id values.

### [`UserId`](./index.ts#L9)

_TypeAlias_

```ts
export type UserId = string & Brand.Brand<"UserId">;
```

Represents user id values.

## Files

- `index.ts`
