---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260728-six-deep-packages-one-version.md
---

# v2 code lives in a top-level `v2/*` workspace

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-v2-lives-top-level), [V2 authority replacement](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#v2-authority-lives-with-v2), and [Router package replacement](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque).

## Supersession

The top-level `v2/*` workspace and zero-v1-import boundary remain
accepted. V2 authority also lives with the V2 track under
`20260729-v2-authority-lives-with-v2.md`; no privileged V2
specification copy lives first on `main`.

The package layout is no longer deferred. The retained scope of
`20260728-six-deep-packages-one-version.md`, as updated by
`20260729-router-order-is-opaque.md`, fixes exactly six packages with
`router` in place of `transport`, their dependencies, exports,
binaries, and shared version.

## Context and Problem Statement

moltzap is rebuilding on a new architecture (v2) while v1 keeps
serving production from `main`. Where does v2 code live so the clean
slate stays clean while main merges forward into the v2 branch?

## Considered Options

- Top-level `v2/*` workspace: new packages, zero imports from
  `packages/*`.
- A `v2/` folder inside each existing package
  (`packages/server/v2/`, ...).
- A separate repository.

## Decision Outcome

Chosen: **top-level `v2/*`**. Per-package v2 folders early-bind v2's
module decomposition to v1's package taxonomy — v1's layout encodes
the architecture v2 rejects (the server package bundles control
plane, data plane, and app machinery the router model deletes), and
v2's decomposition must come from its spec. Shared `package.json`,
dependencies, and compiler baselines would also leak v1 into v2, and
forward merges would touch directories both tracks edit. A separate
repository forfeits shared CI/tooling and the private-repo anonymity
window with no offsetting benefit; npm names are not bound to
folders, so cutover keeps the names either way.

Consequences: the zero-v1-imports boundary is mechanically enforced
in `scripts/check-architecture-boundaries.js`; v2's internal package
layout is deferred to the spec; main→v2 merges stay conflict-free by
construction.
