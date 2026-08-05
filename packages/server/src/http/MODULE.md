# server-core/http

_`packages/server/src/http`_

## Purpose

HTTP server construction barrel.

## Public surface

### [`makeCoreHttpApp`](./routes.ts#L85)

_Function_

```ts
export function makeCoreHttpApp(options: CoreHttpAppOptions)
```

Build the core HTTP app. Composes the two always-on routes
(`/health`, `/ws`) with the auth surface
(`/api/v1/auth/register`) and wraps the router in CORS.

| Route                              | Mounted unless         | Method | Body                          | Status                                                       |
|------------------------------------|------------------------|--------|-------------------------------|--------------------------------------------------------------|
| `/health`                          | always                 | GET    | —                             | 200 `{status, connections}`                                  |
| `/ws`                              | always                 | GET    | WS Upgrade                    | 101                                                          |
| `/api/v1/auth/register`            | `skipDefaultRegisterRoute` | POST | `Register.params`           | 201 `{agentId, apiKey}`; 400/403/500                         |
The bodied route funnels through `readDecodedBody` for JSON
decode + Effect-Schema strict (excess-rejecting) decode. Invite-gate
checks use `safeEqual`
(constant-time) to compare `inviteCode` against
`registrationSecret`.

**Returns:** The created core http app.

### [`makeNodeHttpServer`](./node-http-server.ts#L7)

_Function_

```ts
export function makeNodeHttpServer()
```

Creates node http server.

**Returns:** The created node http server.

## Files

- `node-http-server.ts`
- `routes.ts`
