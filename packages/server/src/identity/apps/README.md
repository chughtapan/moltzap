# identity/apps/

The app-principal layer: app credential auth + registration, the live app
endpoint registry, the default app, and the fail-closed callback envelope.
Public surface is the `#identity/apps` barrel — boot composes against it and
never reaches a deep private path.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | db, socket, identity siblings (contacts, credential) |
| Imports TO   | composed by `core` boot; consumed by `dispatch`, `network`, `message` (app-authority callers) |

## Files

- `auth.service.ts` — `AppAuthService`: resolves an `appKey` to its `AppContext`
  plus decoded `AppManifest` from one auth row; app registration.
- `layer.ts` — service Tags + live Layers: `AppAuthServiceTag` / `Live`,
  `AppEndpointRegistryTag` / `Live`.
- `registry.ts` — `AppEndpoint` / `AppRegistration` types and `AppRegistry`.
- `endpoint-registry.ts` — `AppEndpointRegistry`: the live app endpoint registry
  keyed by server-minted `AppId`.
- `default-app.ts` — `installDefaultApp`: the `DEFAULT_APP_ID` registration that
  covers ordinary DMs/groups (no moderator).
- `callback-rpc.ts` — `callAppRpc` and `wrapHookEffectWithEnvelope`, the
  fail-CLOSED hook envelope (timeout / on-error / on-timeout fallback verdicts).
