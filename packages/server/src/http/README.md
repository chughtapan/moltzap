# http/

Transport-server HTTP wiring: the route table and the Node listener. It holds
no domain policy; it routes requests to the services that do.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | socket, core, config, identity/credential, moltzap |
| Imports TO   | core only — boot (`core/app.ts`) mounts the HTTP app |

## Files

- `routes.ts` — `makeCoreHttpApp`: the HTTP route table (health, the WebSocket
  upgrade, and `/api/v1/auth/register` gated by `skipDefaultRegisterRoute`).
- `node-http-server.ts` — `makeNodeHttpServer`: the bare Node `http.Server` the
  boot process listens on.
