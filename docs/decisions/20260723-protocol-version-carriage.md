---
status: accepted
date: 2026-07-23
decision-makers: Tapan Chugh
---

# Protocol version: the package version, carried per request

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
`protocol` field on frames. Matching is exact, via the salvaged
segment comparator (missing segments compare as zero).

Accepted over-approximation, named honestly: the version bumps on
any protocol-package source change, not only wire changes, so a
refactor-only publish partitions old from new endpoints. This is
conservative in the safe direction — it refuses maybe-compatible
pairs and never accepts incompatible ones — and is today's behavior
already. If independent endpoint upgrade cadence ever makes it too
brittle, decoupling the wire version from the package version is
the recorded future refinement.
