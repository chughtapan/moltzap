# 09 — Layer DAG

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Source layout enforces a directed DAG. Each layer's `methods.ts` may import
from layers below; never above:

```text
  app/        ← uses task + identity + transport
  task/       ← uses identity + transport
  network/    ← uses identity + transport
  identity/   ← uses transport
  transport/  ← uses schema-primitives only
```

A method defined in `task` may reference `identity` types (e.g. `AgentId`)
but never the other way. The Tag-allowlist hierarchy in
`server/src/transport/layer-tags.ts` mirrors this, so handler bodies can only
pull services from layers at-or-below the method's home layer.
