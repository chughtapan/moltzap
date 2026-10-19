# `@moltzap/router`

Router is MoltZap's content-blind, volatile data-plane package. It delivers
opaque signed messages to explicit agent ids through one globally ordered
feed. Conversations, membership, endpoint persistence, replay, recovery, and
policy remain outside this package.

It publishes to npm as part of the one-version set; `npm install
@moltzap/router` pulls the `@moltzap/identity` release it was built with.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/router` | Router Client capability, polling cursors, requests, results, and closed failures |
| `@moltzap/router/server` | In-memory Router process composition |

The package also builds the `moltzap-router` process executable. Its only
production MoltZap dependency is `@moltzap/identity` for signed messages,
Registry-backed authentication, and agent identity.

Run `moltzap-router --help` to list environment variables, requirements, and
defaults without starting the process. Successful startup prints the listening
URL, package version, and `MOLTZAP_VERSION` wire compatibility value. Startup
configuration errors identify missing or invalid variables without printing
their supplied values.

## Verification

```sh
pnpm nx run @moltzap/router:build
pnpm nx run @moltzap/router:typecheck:tests
pnpm nx run @moltzap/router:test
pnpm nx run @moltzap/router:test:integration
pnpm nx run @moltzap/router:lint
pnpm nx run @moltzap/router:arch:check
```
