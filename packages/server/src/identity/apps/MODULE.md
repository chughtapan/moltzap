# server-core/identity/apps

_`packages/server/src/identity/apps`_

## Purpose

App identity and endpoint registration barrel.

## Public surface

### [`AppEndpoint`](./registry.ts#L16)

_Interface_

```ts
export interface AppEndpoint {
  readonly connId: ConnectionId;
  readonly originator: Originator;
}
```

The minimal server→app dispatch surface a registration needs: the
connection id (for close-time cleanup via `unregisterByConnection`) and
the outbound Originator (the `sendRpcToClient` channel). Minted from
the live `AppConnection` arm's `{ connId, originator }` at `app/connect`.
The boot-installed default app carries an inert endpoint
(`default-app.ts -> makeDefaultAppEndpoint`) whose originator defects. Its
manifest declares only static policies, so domain callback services never
invoke that endpoint.

### [`AppHost`](./host.ts#L11)

_Class_

```ts
export class AppHost {
  private readonly apps = new AppRegistry();
  private contactService: ContactService | null = null;

  registerApp(
    appId: AppId,
    manifest: AppManifest,
    endpoint: AppEndpoint,
  ): boolean {
    const ok = this.apps.register(appId, manifest, endpoint);
    if (ok) {
      Effect.runFork(
        Effect.logInfo("App registered").pipe(
          Effect.annotateLogs({
            appId,
            connectionId: endpoint.connId,
          }),
        ),
      );
    }
    return ok;
  }

  unregisterApp(appId: AppId): void {
    if (this.apps.unregister(appId)) {
      Effect.runFork(
        Effect.logInfo("App unregistered").pipe(Effect.annotateLogs({ appId })),
      );
    }
  }

  unregisterAppsForConnection(connId: ConnectionId): void {
    this.apps.unregisterByConnection(connId);
  }

  lookupApp(appId: AppId): AppRegistration | undefined {
    return this.apps.get(appId);
  }

  setContactService(checker: ContactService): void {
    this.contactService = checker;
  }

  getContactService(): ContactService | null {
    return this.contactService;
  }

  destroy(): void {}
}
```

### [`AppRegistration`](./registry.ts#L31)

_Interface_

```ts
export interface AppRegistration {
  readonly appId: AppId;
  readonly manifest: AppManifest;
  readonly endpoint: AppEndpoint;
}
```

A registered app. There is NO `InProcess` vs `Remote` distinction —
every app, including the boot-installed default, carries an
AppEndpoint. Connected apps hold the `{ connId, originator }`
minted from the `AppConnection` arm their `app/connect` call arrived on;
the default app holds an inert endpoint (see
`default-app.ts -> makeDefaultAppEndpoint`) and declares only static
policies. Domain callback services only call the endpoint for a
`kind: "hook"` policy. AppHost sees one registration shape regardless.

### [`AppRegistry`](./registry.ts#L46)

_Class_

```ts
export class AppRegistry {
  private entries = new Map<AppId, AppRegistration>();

  /**
   * Returns true if the registration was installed, false if `appId`
   * is already present. Never overwrites — the caller MUST unregister
   * first if they want to replace.
   *
   * Keyed by the SERVER-MINTED `appId` (the authenticated
   * `AppConnection.auth.appId`, or `DEFAULT_APP_ID` at boot), NOT by
   * `manifest.appId`. The DB issues `app_id` via `gen_random_uuid()`;
   * the manifest's `appId` field does not participate in routing.
   * `task/request` targets the appId the registrant received from
   * `/api/v1/apps/register`, which is this same server-minted identity.
   */
  register(
    appId: AppId,
    manifest: AppManifest,
    endpoint: AppEndpoint,
  ): boolean {
    if (this.entries.has(appId)) return false;
    this.entries.set(appId, { appId, manifest, endpoint });
    return true;
  }

  unregister(appId: AppId): boolean {
    return this.entries.delete(appId);
  }

  /**
   * Drop every entry whose connection matches `connectionId`. Used
   * by the WS-close path to clean up any apps the closing connection
   * registered.
   */
  unregisterByConnection(connectionId: ConnectionId): void {
    for (const [appId, entry] of this.entries) {
      if (entry.endpoint.connId === connectionId) {
        this.entries.delete(appId);
      }
    }
  }

  get(appId: AppId): AppRegistration | undefined {
    return this.entries.get(appId);
  }

  has(appId: AppId): boolean {
    return this.entries.has(appId);
  }
}
```

Single source of truth for app registrations. The registry has no
notion of "boot" vs "connected" — both go through register.
The registry itself enforces the no-overwrite invariant: any
attempt to register on top of an existing entry returns false.
Callers (`app/connect`, `installDefaultApp`) map a
`false` return to whatever surfacing they need — typed
`ForbiddenError` for the connect path, an exception for boot.

### [`callAppRpc`](./callback-rpc.ts#L18)

_Function_

```ts
export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof DispatchAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof DispatchAuthorize>,
  ReverseCallbackError<typeof DispatchAuthorize> | ReverseCallError
>
```

### [`installDefaultApp`](./default-app.ts#L100)

_Function_

```ts
export function installDefaultApp(appHost: AppHost): void
```

Boot-time installation of the default app. Registers the static-only
manifest under DEFAULT_APP_ID. No app round-trip is ever made.

TM-admin RPCs (rebound to the app principal) remain unreachable on
`DEFAULT_APP_ID` tasks because no client `AppConnection` can ever own
the default app — its endpoint is a server-minted inert endpoint, not
a connected HTTP-registered app.

### [`wrapHookEffectWithEnvelope`](./callback-rpc.ts#L55)

_Function_

```ts
export function wrapHookEffectWithEnvelope<Verdict, E = never>(opts: {
  readonly raw: Effect.Effect<Verdict, E>;
  readonly timeoutMs: number;
  readonly timeoutLogMessage: string;
  readonly timeoutLogContext: Record<string, unknown>;
  readonly errorLogMessage: string;
  readonly errorLogContext: Record<string, unknown>;
  readonly onTimeout: () => Verdict;
  readonly onError: () => Verdict;
}): Effect.Effect<Verdict, never>
```

## Files

- `callback-rpc.ts`
- `default-app.ts`
- `host.ts`
- `registry.ts`
