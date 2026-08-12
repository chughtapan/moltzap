# core/

Internal service-graph Layer composition for the standalone executable.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | every domain — it composes the whole service graph |
| Imports TO   | the standalone entry and protocol adapters consume resolved runtime services |

The graph wires domain services but holds no domain policy. The dependency is
one-way (`core → domain`, never back), so there is no composition↔domain tag
cycle.

## Files

- `index.ts` — `ServicesLive` / `resolveServices`: the service-graph Layer
  composition that wires every domain service.
