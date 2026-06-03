# protocol/testing/toxics

_`packages/protocol/src/testing/toxics`_

## Purpose

Public barrel for Toxiproxy toxic profiles and control helpers.

## Public surface

### [`allToxicTags`](./profile.ts#L51)

_Variable_

```ts
export const allToxicTags = [
  "latency",
  "bandwidth",
  "slicer",
  "reset_peer",
  "timeout",
  "slow_close",
] as const
```

All six toxic tags, enumerated for coverage assertions in Tier D.

### [`defaultToxicProfile`](./defaults.ts#L24)

_Variable_

```ts
export const defaultToxicProfile:
```

### [`makeToxiproxyClient`](./client.ts#L231)

_Function_

```ts
export function makeToxiproxyClient(
  config: ToxiproxyConfig,
): Effect.Effect<ToxiproxyClient, ToxicControlError>
```

### [`ToxicControlError`](./errors.ts#L8)

_Class_

```ts
export class ToxicControlError extends Data.TaggedError(
  "TestingToxicControlError",
)<{
  readonly op: "create-proxy" | "delete-proxy" | "add-toxic" | "remove-toxic";
  readonly status: number;
  readonly body: string;
}> {}
```

Toxiproxy HTTP API returned a non-2xx, or the control endpoint is down.

### [`ToxicHandle`](./client.ts#L36)

_Interface_

```ts
export interface ToxicHandle {
  readonly name: string;
  readonly profile: ToxicProfile;
}
```

A live toxic attachment. Scoped: acquiring adds the toxic to the proxy,
releasing the scope removes it. Tier D properties acquire a
`ToxicHandle` inside `Effect.scoped` so a crashed property still cleans
up.

### [`ToxicProfile`](./profile.ts#L14)

_TypeAlias_

```ts
export type ToxicProfile =
  | {
      readonly _tag: "latency";
      /** Added latency in milliseconds, per-packet. */
      readonly latencyMs: number;
      /** Random jitter in ms, uniform [0, jitterMs). */
      readonly jitterMs: number;
    }
```

Toxic profile DSL.

Per D2 and Invariant I4, adversity is a parameter selected at suite
invocation, not hardcoded case-by-case. A `ToxicProfile` is a named
preset (one of the six toxics) plus its parameters; the Tier D runner
picks the matching Tier C invariant and re-runs it with the toxic
attached.

Exhaustiveness: the `_tag` union covers every toxic named in §5 Tier D
(D1–D6) so the implementer cannot forget a branch in the client dispatch.

### [`ToxicTag`](./profile.ts#L60)

_TypeAlias_

```ts
export type ToxicTag = (typeof allToxicTags)[number];
```

### [`ToxiproxyClient`](./client.ts#L57)

_Interface_

```ts
export interface ToxiproxyClient {
  /** Create a scoped proxy; teardown on release. */
  readonly proxy: (opts: {
    readonly name: string;
    readonly upstream: string;
  }) => Effect.Effect<ToxiproxyProxy, ToxicControlError, Scope.Scope>;
  /** Probe: control plane reachable. */
  readonly ping: Effect.Effect<void, ToxicControlError>;
}
```

### [`ToxiproxyConfig`](./client.ts#L25)

_Interface_

```ts
export interface ToxiproxyConfig {
  /** Control-plane URL, e.g. `http://localhost:8474`. */
  readonly apiUrl: string;
}
```

### [`ToxiproxyProxy`](./client.ts#L46)

_Interface_

```ts
export interface ToxiproxyProxy {
  /** Upstream (real server) address the proxy forwards to. */
  readonly upstream: string;
  /** Client-facing URL (`ws://127.0.0.1:&lt;ephemeralPort>`). */
  readonly listenUrl: string;
  /** Attach a toxic inside a Scope; removed on release. */
  readonly withToxic: (
    profile: ToxicProfile,
  ) => Effect.Effect<ToxicHandle, ToxicControlError, Scope.Scope>;
}
```

A live proxy that sits between TestClient and the real server (or
between real client and TestServer). Acquiring the scope allocates an
ephemeral port and registers the proxy; releasing deletes it.

## Files

- `client.ts`
- `defaults.ts`
- `errors.ts`
- `profile.ts`
