# client/service

_`packages/client/src/service`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`FirewallOptions`](./index.ts#L58)

_TypeAlias_

```ts
  export type FirewallOptions = InstalledFirewallOptions;
```

Trusted fixed process composition; agents receive no policy mutation capability.

### [`layer`](./index.ts#L116)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(Effect.succeed(undefined)),
  )
```

Complete production process composition for `moltzapd`.

### [`MoltZapService`](./index.ts#L56)

_Namespace_

### [`StartupError`](./index.ts#L61)

_Class_

```ts
  export class StartupError extends Data.TaggedError(
    "MoltZapServiceStartupError",
  )<{
    readonly phase: "configuration" | "storage" | "listener";
  }> {
    /**
     * Names only the failed phase, so the process log says why startup stopped.
     * @returns The startup failure message.
     */
    override get message(): string {
      return `moltzapd startup failed in phase ${this.phase}`;
    }
  }
```

Closed daemon startup phase without configuration or platform detail.

### [`withFirewall`](./index.ts#L125)

_Function_

```ts
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError>
```

Fixed middleware and owner evidence are installed before the daemon accepts host calls.

**Returns:** The complete daemon layer with both message boundaries checked.

## Files

- `index.ts`
