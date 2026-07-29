# protocol/identity/apps

_`packages/protocol/src/identity/apps`_

## Purpose

App identity descriptors, identifiers, and credentials.

## Public surface

### [`appId`](./ids.ts#L8)

_Variable_

```ts
export const appId: Schema.Schema<AppId, string> = formatString("uuid").pipe(
  Schema.brand("AppId"),
  Schema.annotations({ description: "Branded AppId" }),
)
```

Validates and decodes app id values.

### [`AppId`](./ids.ts#L6)

_TypeAlias_

```ts
export type AppId = string & Brand.Brand<"AppId">;
```

Represents app id values.

### [`appKey`](./credentials.ts#L23)

_Variable_

```ts
export const appKey: Schema.Schema<AppKey, string> =
  Schema.Redacted(appKeyValue)
```

Validates and decodes app key values.

### [`AppKey`](./credentials.ts#L21)

_TypeAlias_

```ts
export type AppKey = Redacted.Redacted<AppKeyValue>;
```

Represents app key values.

### [`AppManifest`](./manifest.ts#L130)

_TypeAlias_

```ts
export type AppManifest = Schema.Schema.Type<typeof appManifestSchema>;
```

Represents app manifest values.

### [`AppManifestValidationResult`](./manifest.ts#L140)

_TypeAlias_

```ts
export type AppManifestValidationResult = Either.Either<
  AppManifest,
  AppManifestInvalid
>;
```

Represents the result of app manifest validation.

### [`DEFAULT_APP_ID`](./ids.ts#L14)

_Variable_

```ts
export const DEFAULT_APP_ID = Schema.decodeSync(appId)(
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb",
)
```

Validates and decodes default app id values.

### [`manifestPolicyCanaries`](./manifest-policy.types-check.ts#L107)

_Variable_

```ts
export const manifestPolicyCanaries =
```

Aggregate so each binding is referenced (no unused-variable lint).

### [`validateAppManifest`](./manifest.ts#L154)

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

**Returns:** The validate app manifest result.

## Files

- `credentials.ts`
- `ids.ts`
- `manifest-policy.types-check.ts`
- `manifest.ts`
