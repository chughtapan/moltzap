# protocol/identity/apps

_`packages/protocol/src/identity/apps`_

## Purpose

App identity descriptors, identifiers, and credentials.

## Public surface

### [`AppId`](./ids.ts#L5)

_TypeAlias_

```ts
export type AppId = string & Brand.Brand<"AppId">;
```

### [`AppId`](./ids.ts#L5)

_Variable_

```ts
export type AppId = string & Brand.Brand<"AppId">
```

### [`AppKey`](./credentials.ts#L20)

_TypeAlias_

```ts
export type AppKey = Redacted.Redacted<AppKeyValue>;
```

### [`AppKey`](./credentials.ts#L20)

_Variable_

```ts
export type AppKey = Redacted.Redacted<AppKeyValue>
```

### [`DEFAULT_APP_ID`](./ids.ts#L11)

_Variable_

```ts
export const DEFAULT_APP_ID = Schema.decodeSync(AppId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
)
```

## Files

- `credentials.ts`
- `ids.ts`
