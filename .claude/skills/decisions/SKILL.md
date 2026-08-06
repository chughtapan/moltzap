---
name: decisions
description: |
  The procedure for architecture decision records in docs/decisions/ —
  when a choice earns a record, what the record must carry, how a point
  correction differs from a supersession, and how the blind review gate
  runs before one lands. Load before adding, editing, superseding, or
  reviewing an ADR, or before compacting a trajectory into
  docs/decision-evidence/.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Agent
---

# Decision records

`docs/decisions/` is the durable log. `README.md` is the human-maintained
index; frontmatter is authoritative for status.

`pnpm exec tsx scripts/docs/adr/check-shape.ts` enforces every mechanical rule
— filename and date agreement, the status enum, `decision-makers`, provenance
link and anchor resolution, the `superseded-by`/`Supersession` pairing, an
index row, and the changelog rule below. It runs in `pnpm lint` and, in
`--staged` mode, from `.husky/pre-commit`. **Do not re-state those rules here
or in AGENTS.md.** What follows is only what a script cannot decide.

## Section index

| When | Read |
|---|---|
| writing or editing a trajectory under `docs/decision-evidence/` | `references/provenance.md` |
| running the blind gate | `references/questions.md` in the `cold-read` skill |

## Admission

**Admission is maintainer-gated. Do not add a record until the maintainer has
decided the choice belongs in the log.** An agent proposes; a human admits.

Record durable choices about architecture boundaries, public interfaces or wire
contracts, guarantees and fault assumptions, persistence or recovery, security
or trust, package ownership, compatibility, or the replacement of an accepted
decision.

Do not admit a record whose Decision Outcome is an unresolved question, a
proposal awaiting a decision, a temporary implementation plan, or a routine
local detail. A decided outcome may name questions it deliberately leaves open;
those belong in the governing vision or spec, and proposals belong in their
draft location.

## Shape

Name records `YYYYMMDD-short-kebab-title.md`. Dates rather than sequence
numbers, because two people adding a record on the same day should not conflict.

State the binding outcome in present tense, and describe guarantees separately
from mechanisms. Every new record carries `Context and Problem Statement`,
`Decision Outcome`, and `Consequences`; older admitted records keep the body
shape they were admitted with, so do not retrofit them.

`accepted` means the Decision Outcome is current. `partially-superseded` means
only the scope explicitly retained in `Supersession` is current. `superseded`
means the record is historical. A superseded record's `Supersession` section
says precisely what remains current, what was replaced, and where the current
contract now lives — a reader who lands on it must not have to guess which
sentences still bind.

## Point corrections versus supersession

Never delete, renumber, or silently rewrite an admitted decision.

A correction that leaves the Decision Outcome intact — a moved path, a renamed
term, a corrected link — edits the record in place and appends a dated row to a
`Record changelog` section at the bottom. A changed outcome is a supersession
instead: set the status, add `superseded-by` and a `Supersession` section, or
admit a replacement.

The row is the whole point. Without it, a mechanical fix and a quiet rewrite of
someone's decision look identical to a later reader, and review cannot tell them
apart because both read as a typo fix. Small changes need the receipt, not the
ceremony.

## Landing

Land a decision atomically with any required spec changes, affected
architecture pages, prior-record supersession, and its index row. When it
belongs to a decision manifest, update the trace row, normative owner,
acceptance-evidence family, and any explicit deferral in the same change.

The test: **a cold reader must be able to determine the current decision, its
scope and assumptions, its normative owner, its consequences, and every record
it replaces without consulting chat, issues, or private agent state.** The index
is reviewed Markdown, not generated authority — mechanical integrity is checked,
semantic consistency and lineage are not.

## Blind review gate

After an admitted record is added or changed in a way that touches its status,
outcome, consequences, supersession, provenance link, normative owner, or a
manifest trace row, the exact candidate passes this gate before landing.

Freeze the candidate as a commit or content digest, then:

```
cold-read --file <record> --questions .claude/skills/cold-read/references/questions.md \
          --out docs/decision-evidence/<candidate>-cold-review.md
```

The reviewer is a fresh context that did not author the change and inherits no
conversation, compaction, or memory. `cold-read` enforces that architecturally
by dispatching a subagent with a self-contained prompt — which is why the gate
is a tool rather than an instruction to be careful.

Give it the candidate and the fixed questions, nothing else. No design summary,
no diff tour, no file pointer, no expected answer. Do not coach it mid-run.
`Not discoverable` is a valid answer and usually a finding about the record. A
material author hint invalidates the run.

Start from `docs/decision-evidence/cold-review-template.md`. Record the
candidate identity, reviewer identity and isolation attestation,
duration, unedited answers, independently discovered paths, discovery trail,
author interventions, per-question verdicts, blockers, and the overall result
under `docs/decision-evidence/`. Retain failed and invalid attempts rather than
overwriting them; an invalidated run is evidence too.

**PASS requires all six answers accurate and discoverable.** Any wrong or
unfindable answer, broken locator, unresolved contradiction, invented binding
choice, or need for a hint is FAIL and blocks landing. A maintainer accepts the
result; reviewer prose is not self-certifying.

After a failure, or any semantic change to a record, trajectory, authority,
spec, trace row, rebase, or conflict resolution, freeze a new candidate and use
a different fresh reviewer. Adding only the review artifact, or applying
meaning-preserving formatting, does not invalidate the reviewed candidate.
