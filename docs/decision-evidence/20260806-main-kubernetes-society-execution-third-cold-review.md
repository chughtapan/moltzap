# Blind teammate review — Kubernetes society execution, candidate `78ff2f94`

Non-normative evidence. This record is a quarantined input for later blind
reviews: a future reviewer must not open it during a run.

## Candidate identity

- Repository root: `/home/tapanc/moltzap-pr-917-main`
- Branch: `impl/917-main-local-society`
- Commit: `78ff2f9469040d81eae022d72eca5c869995e878`
- Tree: `b381119471443baaf94922be256046b8527c27d7`
- Working tree clean at freeze.

## Why a new candidate was frozen

The accepted blind review covers candidate `2749adbd`. Commit `089829c7`
amended the admitted record after that review, changing binding text in
`Decision Outcome`:

- `ten agents` to `four agents`, in the acceptance gate and in the non-goals.
- `infrastructure` to `cluster`, the `RunSpec` field name, in two passages.

The agent law requires a new candidate and a different fresh reviewer after any
semantic change to an admitted decision. A changed acceptance criterion and a
renamed contract field are semantic.

## Reviewer identity and isolation attestation

A fresh agent session with no inherited conversation, compaction, memory, or
private state, and no earlier blind-review output. It received only the
candidate repository root and the six fixed questions. It was given no design
summary, no diff tour, no ADR or file pointer, no search term, and no expected
answer. No question was answered and no hint was given during the run.

The reviewer attests that it did not open, read, or grep the contents of any
`*-cold-review.md` or invalid-review record, and that those paths appeared only
in directory listings and `git log --name-status` output.

The reviewer disclosed one porousness in the quarantine: the permitted
trajectory restates prior blind-review verdicts. It reports that this supplied
none of its findings, all of which post-date both prior reviews.

## Duration and interventions

One uninterrupted fresh-agent context, roughly 25 minutes. No author
intervention. No file was modified. `Not discoverable` was not needed for any
question.

## Exact prompt

The reviewer received the candidate repository root, the quarantine constraint
above, and the six questions verbatim from the agent law's blind review gate,
followed by instructions to give a per-question PASS or FAIL verdict, to record
independently discovered paths and its discovery trail, and to close with an
overall result.

## Per-question verdicts

| Question | Verdict |
| --- | --- |
| 1 — what decision is current, what is binding | PASS |
| 2 — what it replaces, retains, where the contract lives | PASS |
| 3 — what an implementer must do, under which assumptions | PASS |
| 4 — decision-makers and cited source events | FAIL |
| 5 — strongest contradiction elsewhere | FAIL |
| 6 — implementable without chat or guessing | FAIL |

## Overall result

**FAIL.** The gate blocks landing.

## Blockers

### The amended text has no receipt and contradicts its own ledger

Two statements binding at this candidate cite no source event, and the retained
events say the opposite:

- The trajectory's own source-gap paragraph states that the example's
  `infrastructure` value "remains the binding shape". The record now names the
  field `cluster`.
- The only retained human statement on cohort size is `lets get to 10 agents
  first and then scale`, and the accepted final-shape prompt says
  `Two-agent, ten-agent, and all 32 OpenClaw/NanoClaw evaluation runs`. The
  record now requires a four-agent run.

Both edits landed in `089829c7` with no `Record changelog` row, no dated
trajectory correction, and no supersession. The commit message states the
amendment "still owes its blind teammate review gate" and that it was committed
with `--no-verify`. `checkChangelogRow` runs only in `--staged` mode, so nothing
caught the missing receipt afterwards.

### The acceptance cohort size is stated three ways

| Source | Says |
| --- | --- |
| The admitted record, binding | four-agent |
| The trajectory, evidence | ten agents |
| `packages/simulator/local/README.md` | ten-agent, never four |
| `packages/simulator/package.json`, `local/profile.test.mjs` | ten-agent, asserted as exactly ten roster entries |
| `packages/simulator/local/four-agent-smoke.mjs` | exists, referenced by nothing |

Authority order does not repair this. The record outranks the profile
documentation and tooling, but the source above the record forbids the way the
four-agent text arrived, so the higher authority does not bless the newer text
while the lower artifacts still implement the older one.

## Accidental gaps the reviewer records

1. Which cohort-size gate binds. Blocking.
2. No `Record changelog` receipt for either in-place amendment.
3. The record's illustrative snippet spells `export default RunSpec.define`,
   while the controller admits only one named `runSpec` export and the
   orientation docs say the same. An implementer copying the snippet fails at
   module load.
4. `autoscaling` sits unscoped in the non-goals beside fairness, borrowing, and
   preemption, while the GKE profile ships a node-pool autoscaler and the
   changelog describes agents that scale on demand. Resolvable only by reading
   the non-goal as run scheduling rather than node pools, a distinction the
   record never draws.
5. `packages/simulator/local/hundred-agent-soak.mjs` is referenced by no
   record, document, or target.
6. Acceptance evidence has no stated location. Removal of the transitional path
   is conditioned on replacement evidence existing, and that removal has already
   happened at this candidate, but the record never says where the evidence must
   live.

## Deliberate deferrals the reviewer confirms

Production Temporal hosting and high availability; generations, restart, rebind,
rejoin, and recovery APIs; replay, resume, and exactly-once external effects;
artifact authority, start-or-attach database, execution-id namespace, and
name-hashing algorithm; new serialization grammars; a public Kubernetes object
model and per-agent workflows; Nomad, Slurm, managed batch, and GKE Autopilot;
scale beyond the small gates; secret protocols, persistent-state recovery,
NetworkPolicy, and multi-tenancy; the bridge transport and wire schema; Effect
Layer constructor names; anything under `v2/*`.

## Independently discovered paths and headings

`docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md`
(Scope and authority; Decision Outcome and its six subsections; Non-goals;
Current owners and earlier outcomes; Consequences);
`docs/decisions/20260727-code-first-simulator-kernel.md` (Supersession);
`docs/decisions/20260729-principal-io-uses-runtime-gateways.md` (Supersession);
`docs/decisions/README.md` (Canonical reading guidance; Records);
`docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md`
and its source-gap list; `docs/decision-evidence/README.md`;
`.claude/skills/decisions/SKILL.md` (Shape; Point corrections versus
supersession; Landing; Blind review gate); `AGENTS.md` (Decisions; Docs);
`v2/AGENTS.md` (Authority and reading order);
`scripts/docs/adr/check-shape.ts` and its `checkChangelogRow`;
`packages/simulator/src/definition.ts`;
`packages/simulator/src/cluster/controller/main.ts`;
`packages/simulator/local/README.md`, `local/profile.test.mjs`, and the
two-, four-, ten-agent and hundred-agent modules;
`packages/simulator/gke/README.md`, `cluster.sh`, `terraform/`, `helm/`;
`docs/simulator/running.mdx`; `CHANGELOG.md`.

## Discovery trail

`git log` and `git status` at HEAD; `ls docs/`, `ls docs/decisions/`,
`ls docs/decision-evidence/`; `git diff --stat origin/main...HEAD -- docs/` to
isolate the candidate; the new record read in full; the diff of the two amended
records and the index; the trajectory read in full; `AGENTS.md`; the decisions
skill and the evidence README for the governing procedure;
`scripts/docs/adr/check-shape.ts`, observing that `checkChangelogRow` is
`--staged`-only; the shape checker run, reporting fifty well-formed records;
`git log --follow` on the record surfacing `089829c7`; `git show 089829c7`
exposing both amendments and the unpaid-gate admission; a quarantine-filtered
repository-wide search for the cohort-size strings; the simulator's definition,
index, and controller entry for the implemented contract; the local and GKE
profile listings, READMEs, package manifest, and profile test; the Terraform
main and the changelog for the autoscaling and hundred-agent conflicts;
`git cat-file` and `git ls-tree` against `a2b55f32` to verify the cross-branch
evidence locators; and the v2 authority record and `v2/AGENTS.md` for the
authority order.

## Acceptance

Not accepted. A maintainer accepts or rejects a blind review result; reviewer
prose is not self-certifying. The cohort-size reconciliation is a maintainer
call, not an agent call.
