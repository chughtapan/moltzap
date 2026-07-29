---
status: accepted
date: 2026-07-22
decision-makers: Tapan Chugh
---

# The spec set lives on main

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260722-spec-lives-on-main).

## Supersession

This record remains accepted. The Gate 1 architecture freeze is the
required reconciled spec change on `main` before simulator or
implementation work begins.

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
