# client/service

_`packages/client/src/service`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`layer`](./index.ts#L75)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> =
    Layer.scopedDiscard(runDaemon)
```

Complete production process composition for `moltzapd`.

### [`MoltZapService`](./index.ts#L24)

_Namespace_

### [`StartupError`](./index.ts#L26)

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

## Files

- `index.ts`
