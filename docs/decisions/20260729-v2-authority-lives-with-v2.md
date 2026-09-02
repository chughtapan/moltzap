---
status: partially-superseded
date: 2026-07-29
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# V2 authority lives with V2

Decision provenance: [compacted trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#v2-authority-lives-with-v2).

## Supersession

Repository-native authority, the stated authority order, atomic landing of an
ADR with its traceability and normative specifications, and the rule that chat,
issues, private state, or another branch alone cannot make a binding decision
remain current. Retained v2 authority and history do not require a duplicate
main-branch copy.

`20260811-four-layer-endpoint-replicated-harness.md` replaces perpetual
main-to-v2 forward merges, authority tied to code under `v2/*`, and continued
pre-cutover branch isolation. It admits one final main merge, freezes routine
forward merges, moves implementation to the seven final `packages/*` owners,
and makes the cutover branch the consolidation path. That branch has since
replaced `main`, and `20260901-six-packages-publish-as-one-version-set.md` selects the npm publication and version policy
this record deferred. The replacement record, `AGENTS.md`, `docs/vision.md`,
and `docs/spec/README.md` own the current authority.

## Context and Problem Statement

V1 and V2 are independent product tracks with different architecture
laws and release obligations. Requiring V2 specifications and decisions
to land on `main` before they become authoritative makes the V1 branch
the approval path for a design it does not implement. It also permits a
V2 implementation branch to contain code whose governing contract is
only current somewhere else.

## Considered Options

- Keep one specification tree authoritative on `main` and forward-merge
  it into the V2 branch.
- Make the V2 track self-contained: its checked-in law, current ADRs,
  normative specifications, architecture guidance, and implementation
  evolve with V2 on the `v2` branch.

## Decision Outcome

Chosen: **V2 authority lives with the V2 track**.

### Binding outcome

The `v2` branch contains the authoritative repository-native contract
for code under `v2/*`. Its authority order is:

1. `AGENTS.md` and the constitution (`docs/vision.md`);
2. current ADR outcomes, including explicitly retained portions of
   partially-superseded records;
3. normative `docs/spec/` chapters;
4. `docs/architecture/` orientation and execution plans; and
5. non-normative evidence and historical inputs.

A binding V2 decision lands in that chain in the same candidate as its
affected traceability, specification, architecture, and lineage
changes. It does not become current merely because it exists in chat,
an issue, private agent state, or the `main` branch.

`main` continues to own the V1 production line and merges forward into
`v2`. V2 does not merge back before cutover, and npm continues to
publish from `main` until a separate cutover decision changes that
rule. No second V2 specification tree is introduced.

### Guarantee

A cold implementer working on the V2 branch can determine the complete
current V2 contract from that branch alone. V1 can continue to ship
without being retrofitted to V2 architecture decisions.

### Mechanism

Repository review, status and supersession lineage, the Gate 1
traceability manifest, and the blind teammate gate keep the branch-local
authority complete and contradiction-free. Those are governance
mechanisms; the guarantee does not depend on a particular merge tool.

### Deliberate deferrals

Publishing from V2, production cutover, V1 retirement, and any later
branch consolidation remain separate decisions.

## Consequences

The earlier requirement that the specification set be current first on
`main` is historical only. Forward merges may carry useful V1 changes
into V2, but they cannot silently replace a current V2 outcome. Changes
to V2 authority land atomically with their normative owners and pass the
same review gates as code-facing contract changes.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-09-01 | Recorded that the publication and version-transition deferral in the Supersession section is selected by `20260901-six-packages-publish-as-one-version-set.md`, and repointed the constitution path from `v2/VISION.md` to `docs/vision.md` after the `v2/` directory was retired. The historical Decision Outcome is unchanged. |
| 2026-09-01 | Repointed the constitution path in the historical authority order to `docs/vision.md`. The historical Decision Outcome is unchanged. |
