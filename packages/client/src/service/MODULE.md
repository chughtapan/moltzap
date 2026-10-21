# client/service

_`packages/client/src/service`_

## Purpose

Production composition for one explicitly configured endpoint daemon.

## Public surface

### [`Daemon`](./index.ts#L93)

_Namespace_

### [`FirewallOptions`](./index.ts#L98)

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

### [`help`](./index.ts#L95)

_Variable_

```ts
  export const help = processHelp
```

Usage text listing the daemon process's environment variables.

### [`layer`](./index.ts#L187)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  )
```

Complete production process composition for `sharnessd`, with the
firewall `SHARNESS_MESSAGE_POLICY_FILE` describes when it is set.

### [`StartupError`](./index.ts#L107)

_Class_

```ts
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "legacy-key";
    readonly keys?: readonly string[];
    readonly detail?: string;
  }> {
    /**
     * Only closed refusal reasons and sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const reason = this.reason === undefined ? "" : ` (${this.reason})`;
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      let remedy = "";
      if (this.reason === "pre-reset") {
        remedy =
          ". Start with a fresh state directory and register again; see https://github.com/chughtapan/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      } else if (this.reason === "outbox-too-old") {
        remedy =
          ". Drain the outbox on the previous release before upgrading, or apply a reset release; see https://github.com/chughtapan/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      }
      return `sharnessd startup failed in phase ${this.phase}${reason}${detail}${remedy}`;
    }
  }
```

Closed startup phase with sanitized configuration details.

### [`withFirewall`](./index.ts#L197)

_Function_

```ts
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError>
```

Fixed middleware and persisted English rules are installed before the daemon accepts host calls.
The environment must not also name a message-policy document.

**Returns:** The complete daemon layer with both message boundaries checked.

## Files

- `index.ts`
