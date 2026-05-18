# 09 — Layer DAG

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Source layout enforces a directed DAG. Each layer's `methods.ts` may import
from layers below; never above:

```mermaid
flowchart TD
    APP["app/"]
    TASK["task/"]
    NETWORK["network/"]
    IDENTITY["identity/"]
    TRANSPORT["transport/"]
    PRIMITIVES["schema-primitives"]

    APP --> TASK
    APP --> IDENTITY
    APP --> TRANSPORT
    TASK --> IDENTITY
    TASK --> TRANSPORT
    NETWORK --> IDENTITY
    NETWORK --> TRANSPORT
    IDENTITY --> TRANSPORT
    TRANSPORT --> PRIMITIVES
```

A method defined in `task` may reference `identity` types (e.g. `AgentId`)
but never the other way. The Tag-allowlist hierarchy in
`server/src/rpc/layer-tags.ts` mirrors this, so handler bodies can only
pull services from layers at-or-below the method's home layer.
