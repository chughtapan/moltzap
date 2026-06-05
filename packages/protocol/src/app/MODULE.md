# protocol/app

_`packages/protocol/src/app`_

## Purpose

Public barrel for app manifest protocol types.

## Public surface

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

- `manifest-policy.types-check.ts`
- `manifest.ts`
