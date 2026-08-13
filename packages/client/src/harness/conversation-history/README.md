# Conversation history

This folder owns package-private, representation-neutral laws for endpoint
conversation history:

- `evidence.ts` collects verified fixed-member evidence for actions, durable
  records, and Router re-anchors with either unanimity or the shared durability
  threshold;
- `state-machine.ts` owns the single pending candidate and atomically promotes
  it when its evidence completes. Its persisted state is also its recovery
  state, so there are no restart planners or promotion slots;
- `action-certified-record.ts` binds opaque bodies, canonical membership,
  Router anchors, and exact-member action evidence;
- `certified-catch-up.ts` validates a nonempty contiguous certified suffix for
  one atomic local transaction without runtime attention;
- `verified-head-reconciliation.ts` selects one verified descendant head
  before a Router re-anchor; and
- `durability-quorum.ts` owns the fixed-membership threshold arithmetic.

Callers verify signatures, membership descriptors, record ancestry, and
Router bindings before entering these helpers. They atomically store each
returned state before signing or reporting completion. The helpers do not
select a public `HarnessClient` result, recovery operation, history method, or
concrete hash representation.
