---
status: accepted
date: 2026-08-06
decision-makers: Tapan Chugh
---

# Decision evidence lives in the brain

Decision provenance: [restructure trajectory](../decision-evidence/20260806-evidence-relocation-trajectory.md#evidence-moves-to-the-brain).

## Context and Problem Statement

`docs/decision-evidence/` holds 20 artifacts and 528K: eight compacted
trajectories, ten blind-review records, and three invalid-run records. Two
problems follow from keeping them in a public git repository.

The blind review gate quarantines prior review records — a reviewer that reads
one is contaminated, and the run is void. Quarantine by convention has already
failed once: a reviewer ran an unfiltered `grep -rn`, surfaced two quarantined
records, disclosed it, and its run was discarded. The material sits in the tree
the reviewer is told to navigate, so the rule depends on the reviewer
remembering an exclusion at every search.

Trajectories quote human conversation. Every source so far is the maintainer's
own session, but the manifest is designed to carry Notion pages, Discord
messages, and meeting notes, and those quote other people. A public repository
is the wrong default for that, and the choice should be made before the first
such citation rather than after.

Both artifact classes are also the wrong shape for git. They are read by search
rather than by diff, they are never merged, and they grow without bound.

## Decision Outcome

`docs/decision-evidence/` moves into the gbrain brain. Git retains no copy.

**Trajectories are searchable; review records are not.** They occupy separate
slug prefixes, and the review prefix is listed in `GBRAIN_SEARCH_EXCLUDE`. A
reviewer answering the source-event question reaches trajectories normally; the
same reviewer cannot surface a prior verdict, because the exclusion is applied
by the search path rather than remembered by the searcher.

**A provenance link names a brain page, not a file.** `Decision provenance:`
carries a slug and an anchor. `scripts/docs/adr/check-shape.ts` resolves it
against the brain instead of the filesystem.

**gbrain is required.** It was already required for the blind gate;
provenance verification now depends on it too, so `pnpm lint` needs a brain
connection and CI carries `GBRAIN_DATABASE_URL`. Fork pull requests receive no
secrets and fail this check. That is accepted: a provenance check that silently
skips when the brain is absent is the failure the check exists to prevent.

**Access is the brain's, not the repository's.** Reading evidence requires a
brain credential. This is the access control the artifacts always needed and
never had.

## Consequences

The repository sheds 528K and 20 files that were never read by diff.

Quarantine stops depending on reviewer discipline. The failure that voided a
run this week cannot recur through search, because the exclusion is enforced
where the query runs.

Roughly 70 files reference `decision-evidence/` — 49 record provenance links,
both agent skills, `AGENTS.md`, `v2/AGENTS.md`, `v2/VISION.md`, `docs/spec/README.md`,
`docs/architecture/l1-l2-implementation-ask.md`, and
`scripts/docs/check-no-hardcoded-constants.ts`, which excludes the directory
from its scan. Every one changes in the same commit as the move.

**The evidence is no longer git-durable, and that is the cost of this
decision.** Git gave replication for free: every clone held every artifact, and
recovering one meant checking out an old commit. A brain gives access control
and search and takes that away. A scheduled export of the evidence tables is
required, not optional, and the three sessions already lost to a machine change
are the argument for it.

**A cold reader without brain access can no longer verify a citation.** They can
see that a record cites a slug; they cannot read it. The blind gate's isolation
model changes from "repository-only" to "repository plus brain, minus the
review prefix."

`GBRAIN_SEARCH_EXCLUDE` is an environment variable, and `resolveHardExcludes`
lets a caller opt back in through `include_slug_prefixes`. It is a guard against
the accidental exposure that actually occurred, not against a determined reader.
A brain-level access rule would be stronger and does not exist today.
