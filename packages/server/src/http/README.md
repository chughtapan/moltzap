# http/

Transport-server HTTP wiring: the route table and the Node listener. The
transport-server side of the boot / transport / app-principal split — it holds
no app-principal policy, it routes requests to the services that do.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | socket, core, config, identity/credential, moltzap |
| Imports TO   | core only — boot (`core/app.ts`) mounts the HTTP app |

## Files

- `routes.ts` — `makeCoreHttpApp`: the HTTP route table (agent
  `/api/v1/auth/register`, `/api/v1/apps/register`, health), gated by
  `skipDefaultRegisterRoute`.
- `node-http-server.ts` — `makeNodeHttpServer`: the bare Node `http.Server` the
  boot process listens on.
