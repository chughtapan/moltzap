# client/service

_`packages/client/src/service`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`Daemon`](./index.ts#L61)

_Namespace_

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

Trusted process composition fixes code and evidence while owner tools edit English rules.

### [`layer`](./index.ts#L133)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  )
```

Complete production process composition for `moltzapd`.

### [`StartupError`](./index.ts#L72)

_Class_

```ts
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly reason?: "outbox-too-old";
  }> {
    /**
     * Names the failed phase and any actionable compatibility refusal.
     * @returns The startup failure message.
     */
    override get message(): string {
      const phase = `moltzapd startup failed in phase ${this.phase}`;
      return this.reason === undefined ? phase : `${phase}: ${this.reason}`;
    }
  }
```

Closed daemon startup phase without configuration or platform detail.

### [`withFirewall`](./index.ts#L142)

_Function_

```ts
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError>
```

Fixed middleware and persisted English rules are installed before the daemon accepts host calls.

**Returns:** The complete daemon layer with both message boundaries checked.

## Files

- `index.ts`
