# http/

Transport-server HTTP wiring for the route table. It holds no domain policy;
it routes requests to the services that do. The standalone composition root
owns the Node listener.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | socket, core, config, identity/credential, moltzap |
| Imports TO   | standalone only — the executable mounts the HTTP app |

## Files

- `routes.ts` — `makeCoreHttpApp`: the HTTP route table (health, the WebSocket
  upgrade, and `/api/v1/auth/register`).
