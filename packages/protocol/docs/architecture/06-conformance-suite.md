# 06 — Conformance suite

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`testing/conformance/` defines properties any compliant client/server pair
must satisfy. Each property ships an **executable** (a divergence proof)
that *intentionally fails* the property to prove the assertion has teeth.

```text
src/testing/conformance/{layer}/<property>.ts
   │
   ├─ property body — Effect that asserts the invariant
   │
   └─ __divergence_proofs__/<property>.proofs.test.ts
        │
        ├─ register<PropertyName>  ── server intentionally violates the
        │                              invariant; property must fail
        │
        └─ vitest runs the proof; failure of failure = pass
```

External consumers (e.g. `moltzap-arena`) drop a ~20-line vitest wrapper
matching the AC22 template (see `packages/protocol/CLAUDE.md`) and the
suite runs against their real WS client.
