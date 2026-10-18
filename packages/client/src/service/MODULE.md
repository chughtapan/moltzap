# client/service

_`packages/client/src/service`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`FirewallOptions`](./index.ts#L63)

_TypeAlias_

```ts
  export type FirewallOptions = InstalledFirewallOptions & {
    /**
     * Dedicated file and adjacent `.partial` staging name for this endpoint's
     * state directory, privately owned by the daemon and published on shutdown.
     */
    readonly auditExport?: string;
  };
```

Trusted fixed process composition; agents receive no policy mutation capability.

### [`HarnessService`](./index.ts#L61)

_Namespace_

### [`layer`](./index.ts#L129)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(Effect.succeed(undefined)),
  )
```

Complete production process composition for `moltzapd`.

### [`StartupError`](./index.ts#L72)

_Class_

```ts
  export class StartupError extends Data.TaggedError(
    "HarnessServiceStartupError",
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

### [`withFirewall`](./index.ts#L138)

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
