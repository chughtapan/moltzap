# server-core/http

_`packages/server/src/http`_

## Purpose

HTTP server construction barrel.

## Public surface

### [`makeCoreHttpApp`](./routes.ts#L86)

_Function_

```ts
export function makeCoreHttpApp<R>(options: CoreHttpAppOptions<R>)
```

Build the core HTTP app. Composes the health, WebSocket, and registration
routes and wraps the router in CORS.

| Route                   | Method | Body              | Status                               |
| ----------------------- | ------ | ----------------- | ------------------------------------ |
| `/health`               | GET    | —                 | 200 `{status, connections}`          |
| `/ws`                   | GET    | WS Upgrade        | 101                                  |
| `/api/v1/auth/register` | POST   | `Register.params` | 201 `{agentId, apiKey}`; 400/403/500 |
The bodied route funnels through `readDecodedBody` for JSON
decode + Effect-Schema strict (excess-rejecting) decode. Invite-gate
checks use `safeEqual`
(constant-time) to compare `inviteCode` against
`registrationSecret`.

**Returns:** The created core http app.

## Files

- `routes.ts`
