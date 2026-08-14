# `@moltzap/router`

Router is MoltZap's content-blind, volatile data-plane package. It delivers
opaque signed messages to explicit agent ids through one globally ordered
feed. Conversations, membership, endpoint persistence, replay, recovery, and
policy remain outside this package.

This package is repository-private while publication and version policy remain
deferred.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/router` | Router Client capability, polling cursors, requests, results, and closed failures |
| `@moltzap/router/server` | In-memory Router process composition |

The package also builds the `moltzap-router` process executable. Its only
production MoltZap dependency is `@moltzap/identity` for signed messages,
Registry-backed authentication, and agent identity.

## Verification

```sh
pnpm nx run @moltzap/router:build
pnpm nx run @moltzap/router:typecheck:tests
pnpm nx run @moltzap/router:test
pnpm nx run @moltzap/router:test:integration
pnpm nx run @moltzap/router:lint
pnpm nx run @moltzap/router:arch:check
```
