# protocol/testing/toxics

_`packages/protocol/src/testing/toxics`_

## Purpose

Public barrel for Toxiproxy toxic profiles and control helpers.

## Public surface

### [`allToxicTags`](./profile.ts#L52)

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

### [`defaultToxicProfile`](./defaults.ts#L25)

_Variable_

```ts
export const defaultToxicProfile:
```

Provides the default toxic profile runtime value.

### [`makeToxiproxyClient`](./client.ts#L267)

_Function_

```ts
export function makeToxiproxyClient(
  config: ToxiproxyConfig,
): Effect.Effect<ToxiproxyClient, ToxicControlError>
```

Creates toxiproxy client.

**Returns:** The created toxiproxy client.

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

### [`ToxicHandle`](./client.ts#L62)

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

### [`ToxicProfile`](./profile.ts#L15)

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

Represents toxic profile values.

### [`ToxicTag`](./profile.ts#L62)

_TypeAlias_

```ts
export type ToxicTag = (typeof allToxicTags)[number];
```

Represents toxic tag values.

### [`ToxiproxyClient`](./client.ts#L84)

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

Describes toxiproxy client.

### [`ToxiproxyConfig`](./client.ts#L26)

_Interface_

```ts
export interface ToxiproxyConfig {
  /** Control-plane URL, e.g. `http://localhost:8474`. */
  readonly apiUrl: string;
  readonly network?: ToxiproxyNetworkConfig;
}
```

Describes toxiproxy config.

### [`ToxiproxyNetworkConfig`](./client.ts#L33)

_Interface_

```ts
export interface ToxiproxyNetworkConfig {
  /** Hostname Toxiproxy should use when dialing the real server upstream. */
  readonly upstreamHost?: string;
  /** Address Toxiproxy should bind inside its own process/container. */
  readonly listenHost?: string;
  /** Hostname conformance clients should use when dialing a Toxiproxy listener. */
  readonly connectHost?: string;
  /** Fixed listener port range for Docker bridge mode. Omit for `:0`. */
  readonly listenPortRange?: ToxiproxyListenPortRange;
}
```

Describes toxiproxy network config.

### [`ToxiproxyProxy`](./client.ts#L72)

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
