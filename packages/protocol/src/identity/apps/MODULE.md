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

### [`AppManifest`](./manifest.ts#L125)

_TypeAlias_

```ts
export type AppManifest = Schema.Schema.Type<typeof AppManifestSchema>;
```

### [`AppManifestValidationResult`](./manifest.ts#L134)

_TypeAlias_

```ts
export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;
```

### [`DEFAULT_APP_ID`](./ids.ts#L11)

_Variable_

```ts
export const DEFAULT_APP_ID = Schema.decodeSync(AppId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
)
```

### [`manifestPolicyCanaries`](./manifest-policy.types-check.ts#L102)

_Variable_

```ts
export const manifestPolicyCanaries =
```

Aggregate so each binding is referenced (no unused-variable lint).

### [`validateAppManifest`](./manifest.ts#L146)

_Function_

```ts
export function validateAppManifest(
  value: unknown,
): AppManifestValidationResult
```

Strict manifest validation. Decodes with `{ onExcessProperty: "error" }` so
an extra key rejects the manifest at this trust boundary (an app manifest is
operator-supplied configuration, not wire traffic). On failure surfaces every
`ParseError` leaf via `ParseResult.ArrayFormatter.formatErrorSync` (one issue
→ one string).

## Files

- `credentials.ts`
- `ids.ts`
- `manifest-policy.types-check.ts`
- `manifest.ts`
