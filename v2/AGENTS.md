# moltzap v2 track

Extends the workspace-root `AGENTS.md`. This file governs work under
`v2/*` and on the `v2` branch.

## Where v2 is right now

The interface spec set (`docs/spec/` on the `v2` branch) is the
founding artifact; epic #755 is the live source for how much of it
exists so far, and the sequencing lives in `VISION.md → The Path`.
Do not write v2 implementation code ahead of the spec chapter that
governs it.

## Working style

- **Interfaces before implementation.** The spec is the deliverable of
  this phase. Implementation conversations wait until the governing
  chapter is approved.
- **Guarantees, not mechanisms.** Spec language states ordering,
  attribution, durability, revocability properties. Ledgers, compilers,
  pipelines, and other mechanisms belong in implementation notes and
  salvage analyses, never in normative interface text.
- **Questions stay questions.** The open-question register in
  `v2/VISION.md` is a deliverable, not a to-do list of things to
  answer inline. Binding an answer requires evidence or a decision by
  the maintainer, recorded where the question is registered.
- **Zero v1 imports.** Nothing under `v2/` imports `@moltzap/*` or
  reaches into `packages/`. v1 is evidence and baseline generator,
  not a dependency. Salvage happens by
  re-implementation against the spec, guided by the salvage analyses,
  never by import. CI enforces the boundary via the architecture
  check named in the workspace `AGENTS.md` Ground rules.
- **The case studies are the falsification harness.** Interface
  decisions must keep `moltzap-propagation-bench` (paper experiments)
  and `moltzap-arena` (Mafia) expressible as pure consumers. When a
  design forces either to reach into internals, the design is wrong.

## Inputs

`v2/inputs/` carries the evidence base this track was founded on;
`v2/inputs/README.md` is the inventory. `VISION.md` is the
constitution and vision.

## Layer map for orientation

Orientation digest only; the canonical text is `VISION.md → The
Constitution`.

| Layer | Concern | Where it runs |
|---|---|---|
| L1 | unforgeable, verifiable identity; principal linkage | endpoint signs; recipients verify; control plane stores registrations |
| L2 | per-message collective ops; ordering; delivery status | data plane (router) |
| L2.5 | conversations: addressing + membership views in-band | control plane mints; data plane routes |
| L3 | personal-trust guardrails: structural + semantic screening | endpoints only |
| L4 | norms as versioned skills; who may speak next, about what | marketplace-distributed; consumed by endpoints |
| L5 | records, monitors, registries, revocation | store is control-plane-side; monitor placement is an open register question |
| L6 | governance of the policies themselves | open |

The L2 semantics charter is issue #765; treat its questions (and the
four paper-required constraints in its comments) as the working
surface for anything L2-shaped.
