# client/service

_`packages/client/src/service`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`Daemon`](./index.ts#L65)

_Namespace_

### [`FirewallOptions`](./index.ts#L70)

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

### [`help`](./index.ts#L67)

_Variable_

```ts
  export const help = processHelp
```

Usage text listing the daemon process's environment variables.

### [`layer`](./index.ts#L141)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  )
```

Complete production process composition for `moltzapd`.

### [`StartupError`](./index.ts#L79)

_Class_

```ts
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly detail?: string;
  }> {
    /**
     * Only sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      return `moltzapd startup failed in phase ${this.phase}${detail}`;
    }
  }
```

Closed startup phase with sanitized configuration details.

### [`withFirewall`](./index.ts#L150)

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
