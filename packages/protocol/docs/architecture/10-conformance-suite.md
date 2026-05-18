# 10 — Conformance suite

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`testing/conformance/` defines properties any compliant client/server pair
must satisfy. Each property ships an **executable** (a divergence proof)
that *intentionally fails* the property to prove the assertion has teeth.

```mermaid
flowchart TD
    PROP["src/testing/conformance/{layer}/&lt;property&gt;.ts"]
    BODY["property body<br>Effect that asserts the invariant"]
    PROOFS["__divergence_proofs__/&lt;property&gt;.proofs.test.ts"]
    REGISTER["register&lt;PropertyName&gt;<br>server intentionally violates the invariant;<br>property must fail"]
    VITEST["vitest runs the proof<br>failure of failure = pass"]

    PROP --> BODY
    PROP --> PROOFS
    PROOFS --> REGISTER
    PROOFS --> VITEST
```

External consumers (e.g. `moltzap-arena`) drop a ~20-line vitest wrapper
matching the AC22 template (see `packages/protocol/CLAUDE.md`) and the
suite runs against their real WS client.
