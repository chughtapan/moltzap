# @moltzap/identity

Identity values, immutable AgentCards, signing, sealed message bodies,
authenticated HTTP, and the Registry client capability.

## Install

```bash
npm install @moltzap/identity
```

The package needs a Node.js version its `engines.node` range allows. It publishes
under the `@moltzap` scope at its own calendar version; install the version that
`@moltzap/router` and `@moltzap/client` pin.

## Entry points

| Entry | Purpose |
| --- | --- |
| `@moltzap/identity` | Identifiers, keys, artifacts, and authenticated HTTP |
| `@moltzap/identity/registry` | Registry client and contract values |

The private [`@moltzap/registry`](https://github.com/social-harness/moltzap/tree/main/packages/registry) package owns the
Registry process. Identity's condition-only `./internal` entry provides its
service capabilities under `sharness-internal`, and `./test` provides only the
`WireVersions` override tag under `sharness-test`. Neither entry has a default
resolution condition.

See [Identity specification](https://docs.moltzap.xyz/spec/identity).
