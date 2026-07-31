# server-core/identity/apps

_`packages/server/src/identity/apps`_

## Purpose

App identity and endpoint registration barrel.

## Public surface

### [`AppAuthService`](./auth.service.ts#L37)

_Class_

```ts
export class AppAuthService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * INSERT a fresh app row. `app_id` is server-issued via the column
   * default (`gen_random_uuid()`), so the client never controls the
   * identity. Returns the plaintext `appKey` exactly once; only the
   * derived `keyId` + `secretHash` persist.
   * @param params Request payload to process.
   * @param params.manifest Value supplied to the operation.
   * @returns The register app result.
   */
  registerApp(params: {
    readonly manifest: AppManifest;
  }): Effect.Effect<{ appId: AppId; appKey: AppKey }> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: AppAuthService) {
          const { appKey, keyId, secretHash } = generateAppKey();

          const { app_id: appId } = yield* takeFirstOrFail(
            this.db
              .insertInto("apps")
              .values({
                manifest_json: params.manifest,
                api_key_id: keyId,
                api_key_secret_hash: secretHash,
              })
              .returning(["app_id"]),
            "Failed to insert app",
          );

          yield* Effect.logInfo("App registered").pipe(
            Effect.annotateLogs({ appId }),
          );

          return { appId, appKey };
        }.bind(this),
      ),
    );
  }

  /**
   * Resolve an app credential to its principal context AND its manifest in
   * one SQL read. The manifest is decoded atomically with the principal so
   * the Connect handler's App-arm never holds a half-authenticated state
   * where the principal exists but the manifest fetch could still fail.
   *
   * `null` on a hash MISS (caller surfaces a uniform `UnauthorizedError`
   * at the wire). A `manifest_json` decode failure on a hash-MATCHING row
   * is an environmental failure (storage corruption) the operator can fix
   * by re-registering, so it surfaces as a 401 with an actionable
   * `reason: "manifest_corrupted"` rather than a 500 defect.
   * @param apiKey Value supplied to the operation.
   * @returns The decoded d.
   */
  authenticateApp(
    apiKey: AppKey,
  ): Effect.Effect<
    { auth: AppContext; manifest: AppManifest } | null,
    UnauthorizedError
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: AppAuthService) {
          const parsed = parseAppKey(apiKey);
          if (!parsed) {
            return null;
          }

          const rows = yield* this.db
            .selectFrom("apps")
            .select(["app_id", "manifest_json", "api_key_secret_hash"])
            .where("api_key_id", "=", parsed.keyId);

          const row = rows[0];
          if (row === undefined) {
            return null;
          }
          if (!safeEqual(hashSecret(parsed.secret), row.api_key_secret_hash)) {
            return null;
          }

          return yield* Either.match(validateAppManifest(row.manifest_json), {
            onLeft: () =>
              Effect.fail(
                new UnauthorizedError({
                  data: { reason: "manifest_corrupted" },
                }),
              ),
            onRight: (manifest) =>
              Effect.succeed({
                auth: new AppContext({ appId: row.app_id }),
                manifest,
              }),
          });
        }.bind(this),
      ),
    );
  }

  /**
   * Read-only manifest lookup for paths OTHER than Connect (admin
   * tooling, observability). Callers hand a `appId` already known-valid
   * from a prior SQL read; a missing row or a `manifest_json` decode
   * failure here is therefore an impossible-state defect, not a
   * caller-actionable error — no concurrent app-row-delete path exists
   * and `manifest_json` corruption surfaces at {@link authenticateApp}'s
   * `UnauthorizedError` channel. The `Effect.die` sites catch the
   * contract violation if the invariant is ever broken upstream.
   * @param appId Value supplied to the operation.
   * @returns The rows result.
   */
  getManifest(appId: AppId): Effect.Effect<AppManifest> {
    return catchSqlErrorAsDefect(
      Effect.gen(
```

SQL-backed app authentication — the App-principal sibling of
AuthService. Reads/writes the `apps` table (`core-schema.sql`)
via Kysely; never touches raw SQL on the typed surface.

The four methods carry distinct error channels:

| Method             | Channel             | SQL failure | Domain failure |
|--------------------|---------------------|-------------|----------------|
| `registerApp`      | `never`             | defect      | none           |
| `authenticateApp`  | `UnauthorizedError` | defect      | hash MISS → `null`; `manifest_json` decode FAIL → `UnauthorizedError` |
| `getManifest`      | `never`             | defect      | impossible-state → defect |
| `installDefaultApp`| `never`             | defect      | none           |

`catchSqlErrorAsDefect` is the explicit `Effect.orDie` boundary in
every body — a bare `never` channel would be a type lie while Kysely's
`SqlError` can propagate, so the conversion is applied at each method's
edge rather than implied by the signature.

### [`appAuthServiceLive`](./layer.ts#L23)

_Variable_

```ts
export const appAuthServiceLive = Layer.effect(
  AppAuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AppAuthService(db);
  }).pipe(Effect.withSpan("AppAuthServiceLive")),
)
```

Provides the app auth service live runtime value.

### [`AppAuthServiceTag`](./layer.ts#L12)

_Class_

```ts
export class AppAuthServiceTag extends Context.Tag("moltzap/AppAuthService")<
  AppAuthServiceTag,
  AppAuthService
>() {}
```

Implements app auth service tag.

### [`AppEndpoint`](./registry.ts#L15)

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
the live `AppConnection` arm's `{ connId, originator }` at `app/network/connect`.
The boot-installed default app carries an inert endpoint
(`default-app.ts -> makeDefaultAppEndpoint`) whose originator defects. Its
manifest declares only static policies, so domain callback services never
invoke that endpoint.

### [`AppEndpointRegistry`](./endpoint-registry.ts#L12)

_Class_

```ts
export class AppEndpointRegistry {
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
}
```

Implements app endpoint registry.

### [`appEndpointRegistryLive`](./layer.ts#L32)

_Variable_

```ts
export const appEndpointRegistryLive = Layer.sync(
  AppEndpointRegistryTag,
  () => new AppEndpointRegistry(),
)
```

Provides the app endpoint registry live runtime value.

### [`AppEndpointRegistryTag`](./layer.ts#L18)

_Class_

```ts
export class AppEndpointRegistryTag extends Context.Tag(
  "moltzap/AppEndpointRegistry",
)<AppEndpointRegistryTag, AppEndpointRegistry>() {}
```

Implements app endpoint registry tag.

### [`AppRegistration`](./registry.ts#L30)

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
minted from the `AppConnection` arm their `app/network/connect` call arrived on;
the default app holds an inert endpoint (see
`default-app.ts -> makeDefaultAppEndpoint`) and declares only static
policies. Domain callback services only call the endpoint for a
`kind: "hook"` policy. AppEndpointRegistry sees one registration shape regardless.

### [`AppRegistry`](./registry.ts#L45)

_Class_

```ts
export class AppRegistry {
  private readonly entries = new Map<AppId, AppRegistration>();

  /**
   * Returns true if the registration was installed, false if `appId`
   * is already present. Never overwrites — the caller MUST unregister
   * first if they want to replace.
   *
   * Keyed by the SERVER-MINTED `appId` (the authenticated
   * `AppConnection.auth.appId`, or `DEFAULT_APP_ID` at boot), NOT by
   * `manifest.appId`. The DB issues `app_id` via `gen_random_uuid()`;
   * the manifest's `appId` field does not participate in routing.
   * `agent/task/request` targets the appId the registrant received from
   * `/api/v1/apps/register`, which is this same server-minted identity.
   * @param appId Value supplied to the operation.
   * @param manifest Value supplied to the operation.
   * @param endpoint Value supplied to the operation.
   * @returns The register result.
   */
  register(
    appId: AppId,
    manifest: AppManifest,
    endpoint: AppEndpoint,
  ): boolean {
    if (this.entries.has(appId)) {
      return false;
    }
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
   * @param connectionId Value supplied to the operation.
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
Callers (`app/network/connect`, `installDefaultApp`) map a
`false` return to whatever surfacing they need — typed
`ForbiddenError` for the connect path, an exception for boot.

### [`callAppRpc`](./callback-rpc.ts#L18)

_Function_

```ts
export function callAppRpc(
  entry: AppRegistration,
  request: Extract<
    ReverseCallbackRequest,
    { readonly definition: typeof dispatchAuthorize }
  >,
): Effect.Effect<
  ReverseCallbackSuccess<typeof dispatchAuthorize>,
  ReverseCallbackError<typeof dispatchAuthorize> | ReverseCallError
>
```

Executes the call app rpc operation.

**Returns:** The call app rpc result.

### [`installDefaultApp`](./default-app.ts#L102)

_Function_

```ts
export function installDefaultApp(
  appEndpointRegistry: AppEndpointRegistry,
): void
```

Boot-time installation of the default app. Registers the static-only
manifest under DEFAULT_APP_ID. No app round-trip is ever made.

App-admin RPCs remain unreachable on
`DEFAULT_APP_ID` tasks because no client `AppConnection` can ever own
the default app — its endpoint is a server-minted inert endpoint, not
a connected HTTP-registered app.

### [`wrapHookEffectWithEnvelope`](./callback-rpc.ts#L74)

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
}): Effect.Effect<Verdict>
```

Executes the wrap hook effect with envelope operation.

**Returns:** The wrap hook effect with envelope result.

## Files

- `auth.service.ts`
- `callback-rpc.ts`
- `default-app.ts`
- `endpoint-registry.ts`
- `layer.ts`
- `registry.ts`
