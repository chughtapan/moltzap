# Decision evidence

This directory preserves source-event provenance and blind-review
records for admitted architecture decisions. It is evidence, not
authority. Current ADR outcomes and their normative owners govern when
an artifact here conflicts with them.

## Artifact types

- A `*-trajectory.md` file is a compacted ledger of events from named
  stored sessions. One trajectory may support several ADRs; stable
  headings let each ADR link to the relevant event group.
- A `*-source-gap.md` file states that the original session could not be
  located and lists only the repositories and searches checked. ADR
  prose or commit messages do not become a substitute conversation.
- A `*-cold-review.md` file records a blind teammate review of an exact
  candidate revision. Start from
  [`cold-review-template.md`](cold-review-template.md) and retain failed
  or invalid attempts rather than overwriting them.

Prior review records are quarantined during a fresh blind review. They
remain checked in and may appear in directory listings or history, but
the reviewer must not open, read, or search their contents until after
submitting the new result. A command that returns an answer or verdict
from one of those quarantined blind-review records invalidates the
fresh run. Engineering-review evidence recorded in candidate ADRs or
trajectories remains ordinary reviewable evidence.

Keep blind-review answers, findings, per-question verdicts, and overall
results inside their quarantined review records. Do not repeat or summarize
that material in an ADR, trajectory, index, or other ordinary review path.
A trajectory may retain the mechanical candidate event while marking the
review output as deliberately omitted; non-blind engineering-review evidence
remains ordinary reviewable evidence.

## Event-ledger rules

Each retained row contains:

1. source system and source session identifier;
2. native message or event locator, plus the enclosing turn and parent
   locator when the source provides them;
3. UTC timestamp and stored actor role;
4. a literal excerpt; and
5. any mechanically observed repository event, kept separate from the
   conversation event.

Quotes preserve source spelling, punctuation, capitalization, hedges,
and question marks. Use an explicit `[omitted: …]` marker for removed
text and label any normalization. Never silently turn a question into a
decision or a tentative phrase into a definitive one.

When a source format has no message ID, identify the event with its
session, turn, event kind, and exact timestamp. Do not mint a
message-shaped identifier that the source did not store.

Include the public agent prompt or option set when it is necessary to
interpret a terse reply. `A`, `B`, `1`, `sure`, and `okay` are
uninterpretable without their directly preceding prompt. An agent's
proposal remains an agent event even when a later repository commit
implements it.

Do not add a compactor's explanation of motives, rationale, confidence,
urgency, causality, or mental state. Record a reason, uncertainty,
deadline, reversal, deferral, or revisit trigger only when a cited event
states it. When no supporting event is present, write `No source event
located`; do not fill the gap from the ADR.

An ADR's `decision-makers` field names the humans accountable for
admission. Stored session events identify only the actor role recorded
by the source system. The compaction does not independently prove who
controlled an account or that every sentence in the ADR came from that
person.

## Compaction and privacy

Commit a selected public exchange, not a raw transcript export. Exclude
credentials, secrets, private third-party material, system prompts,
hidden model reasoning, irrelevant tool payloads, and machine-local
details that do not identify a durable source. State substantive
omissions and redactions.

External session URLs may supplement a source identifier but never
replace the checked-in compaction. Do not silently repair an admitted
trajectory. Add a dated correction tied to newly located source events.
A security or privacy removal uses an explicit redaction marker and
maintainer review.

## Historical inputs

`inputs/` and `drafts/` hold the research, audits, handoffs, and proposals
that decision records cite. They moved here from the retired `v2/` directory
on 2026-09-01 with their text unchanged, so paths inside them describe the
tree as it was; only the relative links that the move broke were repointed.
They are evidence in the sense above, never authority.

| File | Cited by |
|---|---|
| `inputs/v1-code-audit-20260717.md` | `../decisions/20260722-control-plane-encoding.md` |
| `inputs/debt-inventory-20260718.md` | `../decisions/20260722-control-plane-encoding.md` |
| `inputs/simulator-handoff-20260728.md` | `../decisions/20260729-effect-native-evaluation-results.md` |
| `drafts/firewall-plan-proposals/` | `../decisions/20260724-firewall-starts-as-mcp-middleware.md`; see `drafts/README.md` |

Inputs no record cites were deleted with `v2/`; git history retains them.

## Reading responsibility

Use a trajectory like `git blame`: find the source events and repository
changes behind a record, then judge the current ADR separately. A source
gap or provisional human message may justify asking for a replacement
decision. It does not authorize an agent to ignore the current one.
