# Invalid blind review — 282c333c

Result: **INVALID**, self-reported by the reviewer. Retained because an
invalidated run is evidence. The candidate was **not** faulted; see below.

## Review identity

| Field | Value |
|---|---|
| Candidate commit | `282c333c` |
| Reviewer | fresh `general-purpose` subagent, second of the sequence |
| Reviewer session | `cold-reviewer-2@session-36099533` |
| Review date | 2026-08-05 |
| Rerun of | `1dd2ef47` (FAIL, two blockers, both fixed) |

## Why the run is invalid

The reviewer ran two repo-wide greps early in navigation without excluding
`*-cold-review.md` and `*-invalid-review.md`. They returned content lines from
`20260728-gate-1-8a58b135-cold-review.md` and
`20260728-gate-1-post-merge-invalid-review.md`, one of which was
reviewer answer prose.

It disclosed this and stopped, rather than judging its own contamination
harmless. That judgment is precisely what the gate removes from the reviewer,
and the rule is a bright line: a command returning an answer or verdict from a
quarantined record invalidates the run.

The reviewer's own containment notes, recorded because they bound what a rerun
must re-establish rather than because they excuse the breach: every line
returned concerned a different candidate (the 2026-07-28 Gate 1 freeze), it
opened neither file, and it excluded both patterns from all later searches.

## Substantive result, not carried forward

The reviewer reported **no blocker against the record** — six answers accurate
and independently discoverable, every locator resolving, and the mechanical
claim that `check-shape.ts` runs in `pnpm lint` verified by tracing
`pnpm lint` → `workspace:lint` → `lint:adr-shape` rather than taken on trust.

This does **not** count as a pass. A fresh reviewer must reach it independently.

## Findings acted on before the rerun

Four non-blocking findings were fixed in `c77464ee`:

1. **The six questions existed in two byte-identical copies** —
   `cold-review-template.md` and `cold-read/references/questions.md` — with
   nothing keeping them in step. The same invisible drift this record exists to
   stop, on the gate's own mechanism. The template now points at the owner.
2. **`.claude/skills/` is itself a tool-specific location**, while the stated
   reason for dropping `@AGENTS.md` was tool-agnosticism, and `AGENTS.md` named
   skills without paths. The sharpest tension found inside the record's own
   reasoning. `AGENTS.md` now names the plain-Markdown paths.
3. **Split provenance anchor** — the Decision Outcome spans two event groups in
   the ledger and the record linked one. Both are linked now.
4. **`decisions` skill never named `cold-review-template.md`** despite
   enumerating the fields it supplies. Linked.

Plus the root-file wording ("a symlink to *this file*" → "to the `AGENTS.md`
beside it") and stale paths in `v2/drafts/`, which are drafts rather than
protected records.
