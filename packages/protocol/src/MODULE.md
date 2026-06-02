# protocol/src

_`packages/protocol/src`_

## Purpose

Public barrel — protocol layer DAG.

The protocol package is the leaf in the workspace dependency
graph, and internally it is split into five layers with their own
one-way dependency order. Re-exports below are arranged in DAG
order so the file itself is the manifest.

```mermaid
flowchart TD
  app[app/] --> task[task/]
  app --> identity[identity/]
  app --> transport[transport/]
  task --> identity
  task --> transport
  network[network/] --> identity
  network --> transport
  identity --> transport
  transport --> schema[schema-primitives]
```

A `task/*` method may reference `identity/*` types (e.g.
`AgentId`); the reverse import is forbidden. The server's
Tag-allowlist hierarchy in `@moltzap/server-core` mirrors this
DAG: a handler may pull services only from layers at-or-below its
own home layer.

## Public surface

### [`agentClientRpcMethods`](./rpc-registry.ts#L41)

_Variable_

```ts
export const agentClientRpcMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...appRpcMethods,
] as const
```

### [`AnyAgentClientRpcDefinition`](./rpc-registry.ts#L69)

_TypeAlias_

```ts
export type AnyAgentClientRpcDefinition =
  (typeof agentClientRpcMethods)[number] & RpcDefinition<string, any, any>;
```

### [`AnyAppCallbackRpcDefinition`](./rpc-registry.ts#L72)

_TypeAlias_

```ts
export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];
```

### [`AnyNotificationDefinition`](./rpc-registry.ts#L74)

_TypeAlias_

```ts
export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
```

### [`AnyServerRpcDefinition`](./rpc-registry.ts#L67)

_TypeAlias_

```ts
export type AnyServerRpcDefinition = (typeof serverRpcMethods)[number] &
```

### [`appCallableRpcMethods`](./rpc-registry.ts#L48)

_Variable_

```ts
export const appCallableRpcMethods = [
  ...agentClientRpcMethods,
  ...appCallableTaskRpcMethods,
] as const
```

### [`brandedId`](./schema-primitives.ts#L143)

_Function_

```ts
export function brandedId<const BrandName extends string>(brand: BrandName)
```

Convenience over brandedString that adds the `uuid` format. The
canonical way to define wire id types in this package
(`AgentId = brandedId("AgentId")`, `TaskId = brandedId("TaskId")`, etc.).
The format check runs the `UUID_RE` regex at decode time and annotates the
schema so `JSONSchema.make` emits `format:"uuid"` for the docs walker.

### [`brandedString`](./schema-primitives.ts#L45)

_Function_

```ts
export function brandedString<const BrandName extends string>(
  brand: BrandName,
  options: BrandedStringOptions = {},
): Schema.Schema<BrandedString<BrandName>, string>
```

Effect `Schema` whose decoded type is `BrandedString&lt;BrandName>`. The
brand exists only at the type level — decode runs against the underlying
string with the requested refinements (`minLength`, `maxLength`, `pattern`,
and the three wire `format` checkers below) as `Schema.pattern` /
`Schema.filter` refinements inside the same `Schema.decode*` engine as
everything else.

`format` annotates the schema with `{ jsonSchema: { format } }` so
`JSONSchema.make` re-emits the draft-07 `format` keyword the docs walker
reads (`scripts/docs/schema.ts → getStringTypeName`). The `pattern`/`filter`
refinement still runs at decode time regardless of the annotation.

### [`BrandedString`](./schema-primitives.ts#L17)

_TypeAlias_

```ts
export type BrandedString<BrandName extends string> = string &
```

A `string` carrying a nominal `Brand.Brand&lt;BrandName>` tag. Prevents
a `string` from accidentally type-fitting a slot expecting the brand.

`Schema.brand` produces `string & Brand.Brand&lt;BrandName>`, identical to
this alias, so a `brandedString("Foo")` schema's `Schema.Schema.Type` is
assignable both ways with `BrandedString&lt;"Foo">`.

### [`BrandedStringOptions`](./schema-primitives.ts#L24)

_Interface_

```ts
export interface BrandedStringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: WireStringFormat;
  readonly description?: string;
}
```

Refinement options accepted by brandedString.

### [`checkProtocolRange`](./version.ts#L143)

_Function_

```ts
export function checkProtocolRange(
  params: { readonly minProtocol: string; readonly maxProtocol: string },
  serverVersion: string,
): Effect.Effect<void, ProtocolMismatchError | InvalidProtocolVersionError>
```

Range-check the client's protocol-version interval against an
injected server version. Runs at `network/connect` BEFORE auth
resolution; the server-side handler in
`@moltzap/server-core/identity/handlers/connect.handlers.ts`
yields this Effect as the FIRST step of `handleConnect`.

`serverVersion` is a parameter (not the `PROTOCOL_VERSION` constant)
so regression tests can inject future-version values, and the
function lives in `@moltzap/protocol` so tests can import it without
a seam through the server-internal handler module.

Two error channels, both typed:

- `ProtocolMismatchError` — versions are well-formed, just outside
  the supported range. Two `reason` discriminants in the wire
  error's `data` field:
  - `server-above-client-max` —
    `compareProtocolVersion(serverVersion, params.maxProtocol) > 0`.
    The server is newer than the client knows how to talk to.
  - `server-below-client-min` —
    `compareProtocolVersion(serverVersion, params.minProtocol) < 0`.
    The client is newer than the server supports.
- `InvalidProtocolVersionError` — `params.minProtocol` or
  `params.maxProtocol` is not a well-formed numeric version
  string. Untrusted client input crosses the boundary here, so
  the sync throw in compareProtocolVersion is wrapped in
  `Effect.try` and surfaces as a typed channel error. Callers
  (the `network/connect` handler) catch this and map to
  `InvalidParamsError` (JSON-RPC `-32602`).

Production callers (`handleConnect`) pass the live
`PROTOCOL_VERSION` constant; tests inject future-version values
to exercise rejection paths against an unbumped branch.

Example test usage: `Effect.runSync(Effect.either(checkProtocolRange({
minProtocol: "2026.526.0", maxProtocol: "2026.526.0" },
"2026.527.0")))` resolves to a `Left` carrying a
`ProtocolMismatchError` whose `data.reason` is
`"server-above-client-max"`.

### [`closedStructGuard`](./schema-primitives.ts#L246)

_Function_

```ts
export function closedStructGuard<A, I>(
  schema: Schema.Schema<A, I>,
): (value: unknown)
```

Build a boolean type-guard from a `Schema` that REJECTS excess keys,
matching the former `ajv.compile(schema)` strict type guards. A bare
`Schema.is(schema)` ACCEPTS excess (loosening the trust boundary), so the
standalone validators (`validateAgent`, `validateMessage`, …) wrap a
strict `decodeUnknownEither` instead.

### [`compareProtocolVersion`](./version.ts#L71)

_Function_

```ts
export function compareProtocolVersion(a: string, b: string): -1 | 0 | 1
```

Numeric comparator for `PROTOCOL_VERSION` strings, ordered by their
dotted numeric segments (NOT lexicographically).

CalVer values of the form `YYYY.NNNN.M` carry variable-digit middle
components, so lexicographic ordering is wrong:
`"2026.1001.0".localeCompare("2026.527.0") === -1` (lex: `1001 <
527`), opposite of the numeric truth. The `network/connect`
old-client-rejection gate routes through this helper so it stays
correct as the publish workflow rolls the middle component past
`999`.

Returns `-1 | 0 | 1` with conventional semantics:

    compareProtocolVersion("2026.527.0",  "2026.527.0")  →  0
    compareProtocolVersion("2026.526.0",  "2026.527.0")  → -1
    compareProtocolVersion("2026.1001.0", "2026.527.0")  →  1   // numeric, NOT lex
    compareProtocolVersion("2025.999.0",  "2026.1.0")    → -1   // year boundary
    compareProtocolVersion("2026.527.0",  "2026.527.1")  → -1

Each input MUST be a dotted `n.n.n` (or wider) numeric string. The
function is intentionally strict — it does NOT accept SemVer
pre-release suffixes (`2026.527.0-rc.1`) or build metadata
(`2026.527.0+abc`). Empty segments (e.g., `"2026..0"`) and
non-digit characters (`"abc"`) also reject — `Number("") === 0`
would otherwise silently coerce, contradicting the strict /
fail-closed contract.

Throws InvalidProtocolVersionError (a `Data.TaggedError`) on
any malformed segment. Untrusted client input MUST be funnelled
through checkProtocolRange, which wraps this call in
`Effect.try` so the parse error flows through the Effect channel
rather than escaping as a sync throw into the JSON-RPC handler.

### [`dateTimeStringSchema`](./schema-primitives.ts#L188)

_Function_

```ts
export function dateTimeStringSchema(): typeof DateTimeStringSchema
```

Returns the shared `DateTimeStringSchema` singleton. Functioned so callers
can keep `as const` references stable while the schema body is owned here.

### [`DecodedResponseError`](./rpc-registry.ts#L91)

_Class_

```ts
export class DecodedResponseError extends Data.TaggedClass("ResponseError")<{
  readonly frame: ResponseFrame;
  readonly id: JsonRpcId;
  readonly error: Extract<ResponseFrame, { error: unknown }>["error"];
}> {}
```

Discriminated error arm of a decoded JSON-RPC response — wire-frame
decoder discriminator, not an Effect tagged error (the wire `error`
sub-object carries `code`/`message`/`data`, no Effect machinery).

### [`DecodedResponseSuccess`](./rpc-registry.ts#L78)

_Class_

```ts
export class DecodedResponseSuccess extends Data.TaggedClass(
  "ResponseSuccess",
)<{
  readonly frame: ResponseFrame;
  readonly id: JsonRpcId;
  readonly result: unknown;
}> {}
```

Discriminated success arm of a decoded JSON-RPC response.

### [`DecodedServerInbound`](./rpc-registry.ts#L102)

_TypeAlias_

```ts
export type DecodedServerInbound =
  | DecodedResponseSuccess
  | DecodedResponseError
  | ({
      readonly _tag: "ServerRequest";
    } & DecodedRpcRequest<AnyAppCallbackRpcDefinition>)
```

Decoded shape of a frame inbound to the client (from server):
a response (success XOR error), a server-initiated task-callback
request, or a notification.

### [`decodeServerInbound`](./rpc-registry.ts#L167)

_Function_

```ts
export function decodeServerInbound(
  parsed: unknown,
): Effect.Effect<DecodedServerInbound, MalformedFrameError>
```

Typed entry point for client-inbound frames (used by the client to
decode what the server sends). Fails closed with
`MalformedFrameError` on any wire-level mismatch.

```mermaid
flowchart TD
  A["raw socket payload<br>(JSON.parse happens before this call)"]
  A --> B["decodeFrame(parsed)"]
  B --> C{tag?}
  C -->|Request| D["decodeRpcRequest(appCallbackMethods)<br>→ ServerRequest"]
  C -->|Response| E["decodeResponseFrame<br>→ ResponseSuccess | ResponseError"]
  C -->|Notification| F["decodeNotification(notificationDefs)<br>→ Notification"]
  D --> G[DecodedServerInbound]
  E --> G
  F --> G
```

Client-inbound `Request` frames are restricted to
`appCallbackMethods` (the subset the server is allowed to call
back into the client — `dispatch/authorize`, etc.). Response
frames with `id === null` fail closed since a null id has no
pending call to resolve.

### [`decodesStrictly`](./schema-primitives.ts#L229)

_Function_

```ts
export function decodesStrictly<A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): boolean
```

Whether `value` decodes cleanly against `schema` with excess-key rejection
(the strict AJV-parity check). The canonical boolean form used by the wire
frame validators, the standalone struct guards, and the conformance ports —
built on `Either.match` (the repo's required Either discriminant).

### [`DEFAULT_PAGE_LIMIT`](./pagination.ts#L14)

_Variable_

```ts
export const DEFAULT_PAGE_LIMIT = 50
```

### [`formatString`](./schema-primitives.ts#L157)

_Function_

```ts
export function formatString(format: WireStringFormat): Schema.Schema<string>
```

Unbranded `Schema.String` carrying one of the three wire `format` checkers.
Use for `result`/nested string fields that need a `format` but no brand
(e.g. a `claimUrl` `uri`, a raw `uuid`-shaped id field). Emits the draft-07
`format` keyword for the docs walker and runs the regex/finiteness
refinement at decode time.

### [`InvalidProtocolVersionError`](./version.ts#L29)

_Class_

```ts
export class InvalidProtocolVersionError extends Data.TaggedError(
  "InvalidProtocolVersionError",
)<{ readonly version: string; readonly segment: string }> {
  override get message(): string {
    return `compareProtocolVersion: invalid segment ${JSON.stringify(this.segment)} in ${JSON.stringify(this.version)}`;
  }
}
```

Raised by compareProtocolVersion (and surfaced through the
Effect channel of checkProtocolRange) when an input string
carries a non-numeric or empty segment — e.g., SemVer pre-release
suffixes like `2026.527.0-rc.1`, leading/trailing dots like
`"2026..0"`, or non-digit characters like `"abc.def"`.

A `Data.TaggedError` so the error flows through Effect's typed `E`
channel cleanly (`Effect.catchTag("InvalidProtocolVersionError",
...)` works in checkProtocolRange's caller) and matches the
sibling ProtocolMismatchError convention in
`network/methods.ts`.

This is INPUT-VALIDATION for untrusted client-supplied version
strings, not a wire-protocol error. The `network/connect` handler
catches it and maps to `InvalidParamsError` (JSON-RPC -32602) so the
client gets a typed malformed-input response, not a defect.

### [`ListCursor`](./schema-primitives.ts#L195)

_TypeAlias_

```ts
export type ListCursor = BrandedString<"ListCursor">;
```

### [`listCursorSchema`](./schema-primitives.ts#L204)

_Function_

```ts
export function listCursorSchema(): typeof ListCursorSchema
```

### [`ListLimitSchema`](./pagination.ts#L23)

_Variable_

```ts
export const ListLimitSchema = Schema.optional(
  Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
  ),
)
```

### [`MAX_PAGE_LIMIT`](./pagination.ts#L18)

_Variable_

```ts
export const MAX_PAGE_LIMIT = 200
```

### [`notificationDefinitions`](./rpc-registry.ts#L60)

_Variable_

```ts
export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...appNotifications,
] as const
```

### [`PROTOCOL_VERSION`](./version.ts#L9)

_Variable_

```ts
export const PROTOCOL_VERSION = "2026.529.0"
```

### [`serverRpcMethods`](./rpc-registry.ts#L53)

_Variable_

```ts
export const serverRpcMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...taskRpcMethods,
  ...appRpcMethods,
] as const
```

### [`STRICT_DECODE`](./schema-primitives.ts#L221)

_Variable_

```ts
export const STRICT_DECODE =
```

Decode-time option that makes a `Schema.Struct` REJECT extra keys.

Effect's `Schema.Struct` STRIPS excess keys by default
(`onExcessProperty:"ignore"`) — `Schema.decodeUnknownEither(S)({a,extra})`
returns `Right` with `extra` silently dropped, and `Schema.is(S)` returns
`true`. The wire boundary must REJECT excess instead: the conformance
`extra-property` / `oversized` mutators assert that a frame with an extra
key FAILS. So every decode boundary MUST pass this option (or use
closedStructGuard) to enforce that rejection.

### [`stringEnum`](./schema-primitives.ts#L168)

_Function_

```ts
export function stringEnum<T extends string[]>(
  values: [...T],
): Schema.Schema<T[number]>
```

`Schema.Literal(...values)` typed as the union of the literal values. Use
instead of `Schema.Union(Schema.Literal("a"), Schema.Literal("b"))` — same
wire shape, simpler schema. `JSONSchema.make` renders a literal union as
`{ "enum": [...] }` (string-valued), which the docs walker reads off
`.enum`.

### [`WireStringFormat`](./schema-primitives.ts#L21)

_TypeAlias_

```ts
export type WireStringFormat = "uuid" | "uri" | "date-time";

/** Refinement options accepted by {@link brandedString}. */
export interface BrandedStringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: WireStringFormat;
  readonly description?: string;
}
```

The three wire string formats.

## Files

- `pagination.ts`
- `rpc-registry.ts`
- `schema-primitives.ts`
- `version.ts`
