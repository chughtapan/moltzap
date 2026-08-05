---
name: cold-read
description: |
  Read a published artifact — a decision record, spec chapter, PR body, or
  design doc — with NO prior session context, and report how a cold-start
  reader would fare. Scores clarity, completeness, actionability, and trust,
  lists friction with evidence, and emits SHIP / REVISE / REJECT. With
  --questions, answers a fixed question set instead of the default rubric;
  that is how the blind review gate for decision records runs.
  Use before handing an artifact off. Do NOT use to rewrite it — this reads.
allowed-tools:
  - Bash
  - Read
  - Write
  - Agent
---

<!--
Vendored from safer-by-default `dogfood` 0.5.0 (github.com/chughtapan/safer-by-default),
forked 2026-08-05. Edit this file directly; it is no longer generated from an
upstream template, and the plugin's bin/ utilities are deliberately absent.
-->

# cold-read

## Iron rule

> **Read the artifact as if you have never seen this project before. Any
> context borrowed from conversation is a bug in the artifact.**

The enforcement is architectural, not aspirational. You dispatch a subagent via
the `Agent` tool with a self-contained prompt: artifact content, question set,
output schema. No session history, no parent epic, no conversation crumbs. If
the subagent needs context to act, the artifact did not carry its own weight —
that is the finding.

This is why the skill is worth more than a careful re-read by the author. An
author cannot un-know the conversation that produced the artifact; a fresh
subagent has never had it.

## Role

You are the cold-start reader. Given an artifact reference you:

1. Resolve it to a single self-contained text payload.
2. Spawn a subagent with ONLY that payload, the question set, and the schema.
3. Collect the structured report.
4. Write it where the caller asked, or print it.
5. Report the verdict.

You do not rewrite the artifact, open a PR against it, or explain what the
author meant. Every attempt to fill in context is the debt this surfaces.

## Inputs

- One of `--file PATH`, `--issue N`, `--pr N`.
- `--questions PATH` — use a fixed question set instead of the default rubric.
- `--out PATH` — write the report here instead of stdout.
- `--repo owner/name` — override the current repo.
- `gh` authenticated, for `--issue` / `--pr`.
- The `Agent` tool available in the running harness. Without it this skill
  cannot enforce its own iron rule; stop rather than reading the artifact
  yourself.

## Scope

**In scope:** reading a published artifact cold and reporting what a fresh
reader cannot do with it.

**Forbidden:** editing the artifact; consulting the conversation that produced
it; reading sibling artifacts to fill a gap; softening a finding because you
know what was meant.

## Workflow

### Phase 1 — Resolve inputs

```bash
KIND=""; ID=""; FILE_PATH=""; QUESTIONS=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file)      KIND="file"; FILE_PATH="$2"; shift 2 ;;
    --issue)     KIND="issue"; ID="$2"; shift 2 ;;
    --pr)        KIND="pr"; ID="$2"; shift 2 ;;
    --questions) QUESTIONS="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --repo)      REPO="$2"; shift 2 ;;
    *) echo "ERROR: unknown arg: $1"; exit 1 ;;
  esac
done
[ -z "$KIND" ] && { echo "ERROR: one of --file PATH, --issue N, --pr N required"; exit 1; }
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo unknown/unknown)}"
```

### Phase 2 — Fetch the payload

Every byte a cold reader would see, and nothing else.

```bash
PAYLOAD=$(mktemp)
case "$KIND" in
  file)
    [ -f "$FILE_PATH" ] || { echo "ERROR: no such file: $FILE_PATH"; exit 1; }
    { echo "# Artifact: $FILE_PATH"; echo; cat "$FILE_PATH"; } > "$PAYLOAD"
    ARTIFACT_REF="$FILE_PATH" ;;
  issue|pr)
    { echo "# Artifact: $KIND $REPO#$ID"; echo
      gh "$KIND" view "$ID" --repo "$REPO" --json title,body \
        -q '"## Title\n\(.title)\n\n## Body\n\(.body)"'; } > "$PAYLOAD"
    ARTIFACT_REF="$KIND #$ID in $REPO" ;;
esac
[ -s "$PAYLOAD" ] || { echo "REJECT: artifact is empty"; exit 1; }
```

An empty payload fires the stop rule. Do not dispatch a subagent against
nothing — it will produce a plausible report about an absence.

### Phase 3 — Build the self-contained prompt

There are two isolation models, and using the wrong one wastes the run.

**Default (rubric) — payload-only.** The prompt carries the framing, the
rubric, the schema, and the artifact text, and nothing else. The question is
whether the artifact carries its own weight, so anything the reviewer can reach
beyond it is contamination.

**`--questions` — repository-scoped.** The prompt carries the framing, the
questions, the schema, and the *path* to the candidate. The reviewer navigates
the repository normally: search, history, and the checked-in indexes are all
allowed. Questions of the form "what does this replace" and "find the strongest
contradiction elsewhere" are unanswerable from a payload, and inlining one
would guarantee a false `Not discoverable`.

What isolation means in this mode is that the reviewer inherits no
*conversation* — no session history, no design summary, no diff tour, no file
pointer beyond the candidate, no expected answer. Discovering the rest by
navigation is the thing being measured.

In either mode: no issue number, no branch name, no "as we discussed".

The default rubric:

```
Score each axis 0-10, integer, citing evidence from the artifact.
- Clarity        can a cold reader understand it without asking?
- Completeness   is every fact needed to act on it present?
- Actionability  is the next step obvious?
- Trust          is every claim backed by something checkable?

Friction is a list, not a score. Each entry names a location and why a
reader stumbles there.

Verdict:
- SHIP    every axis >= 8 and no friction entry blocks action.
- REVISE  any axis <= 6, or a friction entry blocks action. Name the fixes.
- REJECT  clarity or completeness <= 4. Not publishable as is.
```

Stop rules for the subagent, included in the prompt:

1. If you notice yourself drawing on knowledge outside the payload, say so in
   the friction log — that is the artifact failing to carry its context.
2. If the payload references a document it does not contain ("see the plan"),
   name each one.
3. Answer "the artifact does not say" rather than inferring. A confident guess
   is the failure mode this exists to catch.

### Phase 4 — Dispatch cold

Read the prompt file, then call `Agent` with exactly these parameters:

```
Agent({
  description: "Cold-start artifact read",
  subagent_type: "general-purpose",
  prompt: <the text of the prompt file>
})
```

The description stays generic so no project context leaks through the
subagent's bootstrap. **In payload mode this skill's body never reads
`$PAYLOAD` beyond piping it into the prompt file** — the subagent is the only
reader, and reading it yourself to "check" the subagent breaks the enforcement.

In `--questions` mode the subagent has repository access, so the discipline
shifts from what it can reach to what you tell it: name the candidate path and
nothing else. Answering one of its questions mid-run, or pointing it at the
record you know it needs, invalidates the run.

If the reply does not match the schema, re-invoke once with: "Your previous
reply did not match the output schema. Emit only the schema block." Two failed
attempts is a signal about the artifact, not a reason to write the report
yourself.

### Phase 5 — Validate

- Starts with `# Cold read — `.
- Exactly one of `SHIP`, `REVISE`, `REJECT`.
- Default rubric: four scored axes, each an integer 0-10.
- `--questions`: one section per question, none blank.

A report that fails validation twice is emitted as-is with a note. Never
rewrite a finding to make it pass.

### Phase 6 — Emit

With `--out PATH`, write the report there. Otherwise print it. For `--issue` /
`--pr`, `gh issue comment` / `gh pr comment` publishes it to the thread.

Decision-record reviews are filed under `docs/decision-evidence/` as
`<candidate>-cold-review.md`, alongside the trajectories they check.

### Phase 7 — Report the verdict

One line to the caller: verdict, the artifact ref, and where the report went.
Do not summarize the findings — the caller reads the report. Summarizing is how
a REVISE quietly becomes "mostly fine".

## Stop rules

Stop and report rather than working around any of these:

- The `Agent` tool is unavailable. Reading the artifact yourself is not a
  degraded version of this skill; it is the opposite of it.
- The artifact is empty or unreachable.
- You are asked to fix what the report found. That is a separate change by the
  author, not a follow-on here.

## Anti-patterns

- Reading the payload yourself "just to sanity-check" the subagent.
- Passing the artifact's issue number or branch name in the prompt framing.
- Re-running until the verdict improves.
- Treating SHIP as the goal. The goal is an accurate read.
