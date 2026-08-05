# Lane V-a lease reconciliation blind teammate review

## Candidate identity

- Candidate repository root: `/home/tapanc/moltzap-lanev-a`
- Candidate commit: `595edef1`
- Candidate branch as observed: `docs/lane-v-a-lease-reconciliation`, one commit ahead of
  `origin/v2@7329cfb0`
- Candidate subject: `docs: state production reply authority as it is, not as a dispatch lease`
- Candidate scope: eight files, documentation only, no code

## Reviewer identity and isolation attestation

Fresh agent session that did not author or reconcile the candidate. It received only the
candidate repository root, the candidate commit, and the six fixed questions. It was given no
design summary, no diff tour, no ADR or file pointer, no search term, no expected answer, and no
out-of-band index.

The reviewer attests it opened **no** quarantined file. It observed `*-cold-review.md` and
`*-invalid-review*.md` names in one directory listing of `docs/decision-evidence/` and filtered
them from every subsequent search. No command returned an answer or verdict sourced from one.

**Contamination the reviewer disclosed without being asked.** Two `<system-reminder>` blocks
auto-injected an author-side task list containing the string
`Step 4a: Lane V-a — factual ADR/spec corrections`. The reviewer did not request it, states it
did not use it, and grounds every finding in cited repository artifacts. Recorded here because
the gate requires a complete isolation record, not because the reviewer concealed it.

Whether that injection materially assisted the review is a maintainer judgement. The reviewer's
findings are independently checkable against the cited paths, and the author's verification below
reproduced five of six from the repository alone.

## Author interventions

None during the run. The author neither coached the reviewer nor answered questions while it
worked. The author's verification of the findings happened only after the report was delivered
and is recorded separately below.

## Exact prompt

> You are performing a blind teammate review of a candidate repository revision.
>
> Candidate repository root: `/home/tapanc/moltzap-lanev-a`
> Candidate commit: `595edef1`
>
> Read the root `AGENTS.md` first; it governs how this repository's decision records work and
> what this review requires.
>
> Normal repository navigation, history, search, and discovery of the checked-in decision index
> are allowed. Files matching `*-cold-review.md` and `*-invalid-review*.md` under
> `docs/decision-evidence/` are **quarantined**: do not open, read, or search their contents.
> Seeing such a path in a directory listing or in history is fine. If any command returns an
> answer or verdict sourced from one of those files, stop and say the run is invalidated.
>
> This is a read-only review. Do not edit, commit, or push anything.
>
> Answer these six questions, in order:
>
> 1. What decision does this candidate make current, what problem does it resolve, and which
>    statements are binding versus context or non-normative explanation?
> 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the
>    current normative contract live?
> 3. What must an implementer now do or avoid, which layers or consumers are affected, and under
>    what fault, trust, safety, liveness, and compatibility assumptions?
> 4. Which humans are named as decision-makers, which source events does the compacted trajectory
>    cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it
>    explicitly record? Report only what the event ledger states; do not infer motives,
>    confidence, urgency, or rationale.
> 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in
>    the repository. Resolve it using the authority order or report it as a blocker.
> 6. Could a teammate implement the decision without chat or guessing? List every missing link or
>    unresolved choice and classify each as a deliberate deferral or an accidental gap.
>
> `Not discoverable` is a valid answer. Report what you can and cannot establish from the
> repository alone.
>
> Return: your unedited answers to all six questions; the paths and headings you independently
> discovered; your discovery trail (what you looked at, in what order); a per-question verdict of
> PASS or FAIL; any blockers; and an overall PASS or FAIL. Also state explicitly whether you
> opened any quarantined file.

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 — current decision, problem, binding vs. context | PASS |
| 2 — replaced/retained/untouched, normative owner | FAIL |
| 3 — implementer obligations, layers, assumptions | FAIL |
| 4 — decision-makers, cited source events, gaps | FAIL |
| 5 — strongest contradiction under the authority order | FAIL |
| 6 — implementable without chat or guessing | FAIL |

## Overall result

**FAIL.** Blocks landing.

## Blockers

1. **A lower source contradicts `v2/VISION.md`.** VISION.md sits at the top of the authority
   order and states the production `conversation_busy` and local-retry behavior was *selected*.
   The candidate flips an ADR, a manifest trace row, and a spec chapter to *unselected* without
   landing the same reframing in VISION.md.
2. **A binding claim the repository does not support.** The candidate states production reply
   authority is "carried privately in MCP `_meta` under the `xyz.moltzap/events-v1` extension."
   Neither `_meta` nor `xyz.moltzap` appears in any `.ts` file on the candidate tree, and the
   production MCP wire there exposes only `status`. Separately and more seriously,
   `xyz.moltzap/events-v1` is clean-slate-owned by manifest row **G1-DEC-608**,
   `docs/spec/harness/daemon.md`, and `docs/spec/harness/ingress.md`, so assigning it to
   production is a cross-track identifier collision that also contradicts the accepted outcome
   that the two raw MCP surfaces may differ.
3. **"Every production reply invocation sends" is contradicted by live code.**
   `packages/client/src/channel-base/reply-guard.ts` is tracked source on the candidate tree and
   pre-checks a consumed marker before sending. An implementer taking the sentence literally
   would remove the only protection against double-posting.
4. **Source-event attribution was flipped without amending the linked ledger.** The trajectory
   records the named decision-maker answering `A` to a prompt selecting `conversation_busy`
   without a second lease, and summarizes it as *selects*. The candidate recharacterizes that as
   *requested*, leaving each ADR and its own evidence ledger telling different stories.
5. **Non-atomic landing.** `docs/architecture/harness-implementation-slate.md` still specifies
   dispatch leases and `conversation_busy` as production work, contrary to the requirement that a
   decision land atomically with its affected architecture pages.
6. **Partial scrubs inside edited files.** `docs/spec/harness/output.md` retains `LeaseId` in the
   same enumeration from which the candidate removed `lease` elsewhere, and
   `docs/spec/management.md § Search` retains an unqualified membership-DTO prohibition that
   `docs/spec/harness/client.md` narrowed to the network wire, so two Gate-1 chapters now state
   different membership rules. No manifest trace row was updated for the membership narrowing.

## Independently discovered paths and headings

`AGENTS.md` (Constitution; ADR admission, record shape, provenance, lifecycle; Blind teammate
review gate; Docs authority order) · `docs/decisions/` (52 records) · `docs/decisions/README.md`
· `20260801-model-output-is-start-or-bound-reply.md` ·
`20260801-inbound-notifications-separate-content-from-grants.md` ·
`20260801-harness-client-owns-runtime-context.md` · `20260728-gate-1-architecture-freeze.md`
(rows G1-DEC-600, 608, 610, 633, 635, 637, 638, 639, 640, 641) ·
`20260728-endpoint-daemon-speaks-modern-mcp.md` · `docs/spec/harness/client.md`,
`ingress.md`, `output.md`, `daemon.md` · `docs/spec/management.md` (§ Registration and status,
§ Search) · `docs/architecture/harness-implementation-slate.md` · `v2/VISION.md` ·
`docs/decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md` (§ Source record and
compaction method; § Busy behavior answer; § Production registration must recover a lost success;
§ Model output is start or bound reply; § Source gaps, inherited mechanics, and excluded candidate
detail) · `packages/client/src/harness-mcp-wire.ts`, `channel-core.ts`,
`channel-core-enrichment.ts`, `channel-base/reply-guard.ts` ·
`packages/openclaw-channel/src/openclaw-entry.ts` ·
`packages/server/src/identity/agents/auth.service.ts`

## Discovery trail

`AGENTS.md` → `git show --stat` and `git diff` of the candidate commit → `docs/decisions/`
listing and index → the three edited ADRs in full → `docs/decision-evidence/` listing with
quarantined names filtered → the linked trajectory in full → search for `events-v1` across
`packages/`, `v2/`, `docs/` → search for `lease`, `LeaseId`, `conversation_busy` across docs and
source → the three harness spec chapters → `management.md` and the manifest trace rows →
repository-wide search for `_meta` and `xyz.moltzap` → `harness-mcp-wire.ts` → `v2/VISION.md` →
the reply guard and `openclaw-entry.ts` → conversation enrichment and `registerAgent`.

## Author verification of the findings

Performed after delivery, recorded for the maintainer rather than to contest the result.

- Blocker 1 reproduced. `v2/VISION.md` states *selected* and was not updated.
- Blocker 2 partially qualified. `HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v1"` and the
  `_meta` route do exist, but only on the unmerged production stack, not on the candidate tree or
  on `main`. The reviewer's characterization of the claim as unverifiable is therefore too strong
  for the code's existence, and exactly right for its status: the candidate describes behavior no
  merged branch carries. The cross-track ownership collision it raises stands unqualified and was
  missed entirely by the author.
- Blocker 3 reproduced. `packages/client/src/channel-base/reply-guard.ts` is tracked source on the
  candidate tree. The author's premise that PR #941 removed local duplicate-reply suppression was
  wrong.
- Blocker 4 reproduced and is the most serious. The author conflated *was this selected* with
  *did `main` implement it*. Absence of an implementation does not unmake a recorded decision.
- Blockers 5 and 6 reproduced.

Five of six blockers reproduce from the repository alone. The candidate's direction holds — four
of its factual corrections check against code — but it asserts more than the evidence supports.

## Maintainer disposition

Pending. Reviewer prose is not self-certifying, and a FAIL blocks landing regardless.

Per the gate's rerun rule, a reworked candidate must be frozen anew and reviewed by a **different**
fresh reviewer.
