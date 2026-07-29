---
status: superseded
date: 2026-07-22
decision-makers: Tapan Chugh
superseded-by: 20260729-v2-authority-lives-with-v2.md
---

# The spec set lives on main

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260722-spec-lives-on-main) and [replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#v2-authority-lives-with-v2).

## Supersession

This record is fully superseded. V2 authority lives with the V2 track
under `20260729-v2-authority-lives-with-v2.md`. The checked-in
constitution, current ADR outcomes, normative specifications,
architecture guidance, and evidence on the `v2` branch are sufficient
to govern `v2/*`; they do not become current first on `main`.

`main` remains the V1 production branch and continues to merge forward
into `v2`. Npm publishing continues from `main` until a separate
cutover decision. Those workflow facts do not restore a privileged
main-branch copy of the V2 specification.

## Context and Problem Statement

The founding doctrine (`v2/VISION.md`'s original Vision text,
mirrored in `v2/AGENTS.md`) placed `docs/spec/` on the `v2` branch;
but every spec PR — the decision log, the wire-binding decisions, the
deepening docs — has merged to `main`, leaving the `v2` branch
behind and the doctrine false in practice. Where does the spec set
live?

## Considered Options

- Keep the doctrine; forward-merge main into v2 on a routine
  cadence.
- Change the doctrine: the spec set lives on main.

## Decision Outcome

Chosen: **the spec set lives on main**. `docs/spec/`,
`docs/architecture/`, and `docs/decisions/` are main-branch
artifacts, versioned with the production line and flowing forward
into `v2` with every merge. The `v2`
branch remains the v2 code track (`v2/*` workspace, zero imports
from `packages/*`); it holds no privileged copy of the spec.

Consequences: no forward-merge debt can accumulate against the
spec; review gates for spec chapters ride ordinary main PRs.
