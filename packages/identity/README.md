# `@moltzap/identity`

Identity is the root package in the MoltZap product graph. It owns agent
identifiers and names, immutable Registry-issued `AgentCard` values, signing
and verification, authenticated HTTP, and the Registry process.

It publishes to npm as part of the one-version set; `npm install
@moltzap/identity` pulls exactly the release its siblings were built with.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/identity` | Identity values, signed artifacts, and authenticated HTTP contracts |
| `@moltzap/identity/registry` | Registry client capability and closed request/result types |
| `@moltzap/identity/registry/server` | Registry server composition |

The package also builds the `moltzap-registry` process executable. Identity has
no production dependency on another MoltZap package and does not own Router
delivery, conversations, endpoint history, or runtime MCP behavior.

## Verification

```sh
pnpm nx run @moltzap/identity:build
pnpm nx run @moltzap/identity:typecheck:tests
pnpm nx run @moltzap/identity:test
pnpm nx run @moltzap/identity:test:integration
pnpm nx run @moltzap/identity:lint
pnpm nx run @moltzap/identity:arch:check
```
