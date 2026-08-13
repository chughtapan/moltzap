# Main-owned harness ADRs blind teammate review

## Candidate identity

- Candidate repository root: `/home/tapanc/moltzap-candidate-974`, a detached
  worktree created solely for this run
- Candidate commit: `d4b22b4d`
- Candidate branch as authored: `docs/main-owned-harness-adrs`
- Candidate subject: three main-owned ADRs dated 2026-08-05, one compacted
  trajectory, three `docs/decisions/README.md` index rows
- Working tree at freeze: clean, zero modified or untracked files

## Reviewer identity and isolation attestation

Fresh agent session that did not author or reconcile the candidate, and a
different reviewer from the one that reviewed candidate `595edef1`. It received
the candidate repository root and the six fixed questions, and nothing else: no
design summary, no diff tour, no ADR or file pointer, no search term, no
expected answer, no out-of-band index.

The reviewer attests it opened **no** quarantined file. It reports scoping every
recursive documentation search with `--exclude='*cold-review*'
--exclude='*invalid-review*'` or by `--include` to extensions and directories
those files do not occupy, and observing their names once in a single
`ls docs/decision-evidence/` listing, which the gate permits. No command
returned an answer or verdict sourced from one.

### Contamination the reviewer disclosed without being asked

The harness injected a shared session task list into the reviewer's context
three times, unsolicited, as a system reminder. It carries twelve
implementation step titles from the authoring session, among them "Step 12:
register tool on one /mcp + CLI/socket/generic-send deletion", "Step 8: final
profile shape + moltzapd resolves its own port", "Step 9: production
HarnessClient acquisition", and "Step 4b: Lane V-b — one-path design reversal
(amends Constitution)".

The reviewer states it did not act on the list, did not search for anything
named in it, and reached every finding through repository navigation recorded
in its discovery trail. It notes the list contains no verdict, no lineage, no
source event, no authority claim, and no file pointer, and that it confirmed
nothing the reviewer had not already read directly from the ADRs. It offers its
own judgment that the run is not invalidated while stating that the call
belongs to the maintainer, and observes that it cannot un-see the material.

**This is the second consecutive blind run contaminated the same way.** The
review of candidate `595edef1` recorded an equivalent injection of an
author-side task list. The defect is in the harness, not in either reviewer:
the gate is being run in a process that shares a task list with the authoring
session. Until that is changed, no run under this harness can claim strict
isolation.

## Author interventions

None during the run. The author did not coach the reviewer and answered no
questions while it worked. One message was sent mid-run, after two idle
notifications arrived with no report: it asked only for delivery of the report
the reviewer already held, in the format the original prompt specified, and
supplied no hint, pointer, or answer. The author's independent verification of
the findings happened only after the report was delivered and is recorded
separately below.

## Exact prompt

> You are performing a blind teammate review of a candidate repository revision.
>
> Candidate repository root: `/home/tapanc/moltzap-candidate-974`
> Candidate commit: `d4b22b4d`
>
> Work only inside that directory. Normal repository navigation, history,
> search, and discovery of any checked-in index are allowed.
>
> Files matching `*-cold-review.md` and `*-invalid-review*.md` under
> `docs/decision-evidence/` are **quarantined**: do not open, read, grep, or
> search their contents. Seeing such a path in a directory listing or in git
> history is fine. If any command returns an answer or verdict sourced from one
> of those files, stop immediately and say the run is invalidated.
>
> This is a read-only review. Do not edit, commit, or push anything.
>
> Answer these six questions, in order:
>
> 1. What decision does this candidate make current, what problem does it
>    resolve, and which statements are binding versus context or non-normative
>    explanation?
> 2. What earlier outcomes does it replace, retain, or leave untouched, and
>    where does the current normative contract live?
> 3. What must an implementer now do or avoid, which layers or consumers are
>    affected, and under what fault, trust, safety, liveness, and compatibility
>    assumptions?
> 4. Which humans are named as decision-makers, which source events does the
>    compacted trajectory cite for their calls, alternatives, reversals, and
>    deferrals, and what source gaps does it explicitly record? Report only what
>    the event ledger states; do not infer motives, confidence, urgency, or
>    rationale.
> 5. Find the strongest apparent contradiction, stale instruction, or broken
>    lineage elsewhere in the repository. Resolve it using the authority order or
>    report it as a blocker.
> 6. Could a teammate implement the decision without chat or guessing? List
>    every missing link or unresolved choice and classify each as a deliberate
>    deferral or an accidental gap.
>
> `Not discoverable` is a valid answer. Report what you can and cannot establish
> from the repository alone.
>
> Return, in this order:
> - your unedited answers to all six questions
> - the paths and headings you independently discovered
> - your discovery trail: what you looked at, in what order
> - a per-question verdict of PASS or FAIL
> - any blockers
> - an overall PASS or FAIL
> - an explicit statement of whether you opened any quarantined file, and of
>   anything that reached you other than this prompt and the repository itself

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 — current decision, problem, binding vs. context | PASS |
| 2 — replaced/retained/untouched, normative owner | PASS |
| 3 — implementer obligations, layers, assumptions | PASS |
| 4 — decision-makers, cited source events, gaps | PASS |
| 5 — strongest contradiction under the authority order | PASS |
| 6 — implementable without chat or guessing | PASS |

## Overall result

**PASS** on the six-question gate, with two landing-hygiene blockers raised for
the maintainer and two one-line improvements suggested.

## Blockers

Both measured against the root `AGENTS.md` landing rule, "Land a decision
atomically with any required normative spec changes, affected architecture
pages, prior-record supersession, and `docs/decisions/README.md` index row".

1. **`packages/client/AGENTS.md` is factually wrong about the tree, and was
   made wrong in this branch.** It advertises a retired `moltzap` CLI binary and
   a `src/cli/` directory that does not exist. The reviewer treats it as
   merge-blocking on the ground that it is the file an agent reads first when
   touching `packages/client`, and that it contradicts accepted
   `20260721-agents-md-single-source.md` directly.
2. **Three published docs describe retired surfaces** —
   `docs/integrations/openclaw.mdx` (its entire "How it works" section and its
   Mermaid architecture diagram), `docs/architecture.mdx` (package graph
   annotation), and `docs/snippets/install-cli.mdx` (install instructions for a
   binary that no longer ships; also unreferenced dead content).

Non-blocking: the thrice-cited `20260801-harness-client-owns-runtime-context.md`
does not exist on this branch and carries no branch marker; and the trajectory's
correction note says "Two defects" where a third, one-second timestamp delta
between its events 4 and 7 goes unrecorded.

## Author verification of the findings

Performed after delivery, recorded for the maintainer rather than to contest
the result. **Every blocker and both improvements reproduce.**

- Blocker 1 reproduced, and is worse than "stale". `packages/client/AGENTS.md`
  line 5 claims the `moltzap` CLI binary; lines 35 and 36 name
  `src/cli/moltzapd-main.ts` and `src/cli/`. `ls packages/client/src/cli`
  returns "No such file or directory" and the bin map is exactly
  `{"moltzapd":"./dist/moltzapd-main.js"}`. `git diff origin/main..HEAD` on that
  file shows the `src/cli/` paths were **added in this branch**, by the same
  program that deleted the directory. The reviewer's merge-blocking call is
  correct.
- Blocker 2 reproduced in all three files. `docs/integrations/openclaw.mdx`
  names `MoltZapService`, `MoltZapChannelCore`, and `core.sendReply` in prose
  and in its diagram; `docs/architecture.mdx` line 101 annotates the client
  package as bundling the `moltzap` CLI and `MoltZapChannelCore`; and
  `docs/snippets/install-cli.mdx` has no `<Snippet` include and no `docs.json`
  entry anywhere under `docs/`.
- Both improvements reproduced. The 0801 citation appears once with no path and
  no branch, and `ls docs/decisions/20260801-*` returns no such file.

## Maintainer disposition

Pending. Reviewer prose is not self-certifying, and a PASS is a recommendation
rather than an admission.

Two questions belong to the maintainer:

1. **Whether the disclosed task-list injection invalidates the run.** It is the
   second consecutive contaminated run, and the contamination is structural.
2. **Whether the fixes constitute a semantic change requiring a new candidate.**
   Correcting `packages/client/AGENTS.md` and the three stale pages is landing
   hygiene, but adding the third defect and the branch marker edits the
   trajectory, which the gate's rerun rule names explicitly. On the strict
   reading a new candidate and a different fresh reviewer are required.
