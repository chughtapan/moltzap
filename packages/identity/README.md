# @moltzap/identity

Identity values, immutable AgentCards, signing, sealed message bodies,
authenticated HTTP, and the Registry client capability.

| Entry | Purpose |
| --- | --- |
| `@moltzap/identity` | Identifiers, keys, artifacts, and authenticated HTTP |
| `@moltzap/identity/registry` | Registry client and contract values |

The private [`@moltzap/registry`](../registry/README.md) package owns the
Registry process. Identity's condition-only `./internal` entry provides its
service capabilities under `sharness-internal`, and `./test` provides fixtures
under `sharness-test`. Neither entry has a default resolution condition.

See [Identity specification](../../docs/spec/identity.md).
