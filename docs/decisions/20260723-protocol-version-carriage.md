---
status: superseded
date: 2026-07-23
decision-makers: Tapan Chugh
superseded-by: 20260728-six-deep-packages-one-version.md
---

# Protocol version: the package version, carried per request

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260723-protocol-version-carriage).

## Supersession

This record is fully superseded. There is no protocol package. The
MoltZap wire compatibility value is the `MOLTZAP_VERSION` literal in
`packages/identity/src/version.ts`; the npm package version is a separate
release namespace under
`20260901-six-packages-publish-as-one-version-set.md`; the MCP revision and
simulator persisted-schema versions are independently pinned.

## Context and Problem Statement

The constitution binds the protocol version to a calendar date,
matched simply, with no negotiation, carried per request — but not
the field, the value's source, or the match machinery. v1 already
has all three in near-usable form: the protocol package's version is
the wire-protocol version, minted automatically as CalVer
(`YYYY.MDD.N`, a same-day build counter) by the publish pipeline
whenever protocol source changes; the client pins
`minProtocol = maxProtocol` on connect, so the range check is
already point equality in practice.

## Considered Options

- A standalone protocol constant, minted by wire-changing decision
  records.
- Keep the convention: the protocol package's version is the wire
  version, minted by the existing pipeline; change only the
  carriage.

## Decision Outcome

Chosen: **keep the convention; change only the carriage**. The v2
protocol package's published version is the wire-protocol version —
clause 14 verbatim: a calendar date, matched simply, reusing the
existing publish pipeline. The `min`/`max` range parameters die
with connect; the version rides per request as the
`moltzap-protocol` header on control-plane requests — included in
the interim signature's covered components
(`20260723-interim-signature-profile.md`) — and as the envelope's
`protocol` field on messages. Matching is exact, via the salvaged
segment comparator (missing segments compare as zero).

Accepted over-approximation, named honestly: the version bumps on
any protocol-package source change, not only wire changes, so a
refactor-only publish partitions old from new endpoints. This is
conservative in the safe direction — it refuses maybe-compatible
pairs and never accepts incompatible ones — and is today's behavior
already. If independent endpoint upgrade cadence ever makes it too
brittle, decoupling the wire version from the package version is
the recorded future refinement.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-09-01 | Repointed the Supersession section from the deleted `v2/VERSION` file to the Identity-owned literal and the publication record that now owns package versions. The historical Decision Outcome is unchanged. |
