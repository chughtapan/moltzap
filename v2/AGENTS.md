# moltzap v2 track

Extends the workspace-root `AGENTS.md`; governs work under `v2/*` and
on the `v2` branch.

## Structure

- `docs/spec/` (on the `v2` branch) — the interface spec set, the
  founding artifact. Epic #755 is the live source for how much of it
  exists; sequencing lives in `VISION.md → The Path`.
- `v2/inputs/` — the evidence base this track was founded on;
  `v2/inputs/README.md` is the inventory.
- Layer map: canonical text is `VISION.md → The Constitution`.

## Rules

- **Spec first.** Do not write v2 implementation code ahead of the
  spec chapter that governs it; implementation waits until the
  governing chapter is approved.
- **Guarantees, not mechanisms.** Normative interface text states
  ordering, attribution, durability, revocability properties.
  Mechanisms (ledgers, compilers, pipelines) belong in implementation
  notes and salvage analyses.
- **Questions stay questions.** The open-question register in
  `VISION.md` is a deliverable. Binding an answer requires evidence or
  a maintainer decision, recorded where the question is registered.
- **Zero v1 imports.** Nothing under `v2/` imports `@moltzap/*` or
  reaches into `packages/`. Salvage happens by re-implementation
  against the spec, guided by the salvage analyses, never by import.
  Enforced by `scripts/check-architecture-boundaries.js` (run by
  `pnpm lint`).
- **Case studies are the falsification harness.** Interface decisions
  must keep `moltzap-propagation-bench` (paper experiments) and
  `moltzap-arena` (Mafia) expressible as pure consumers; a design that
  forces either to reach into internals is wrong.
- **L2 work** treats the #765 charter's questions and the four
  paper-required constraints (`VISION.md → The Constitution`, L2
  clause) as its working surface.
