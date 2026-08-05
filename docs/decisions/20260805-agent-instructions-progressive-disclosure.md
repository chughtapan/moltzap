---
status: accepted
date: 2026-08-05
decision-makers: Tapan Chugh
---

# Agent instructions load progressively

Decision provenance: [restructure trajectory](../decision-evidence/20260805-agent-instruction-restructure-trajectory.md#agents-md-progressive-disclosure), and the symlink clause at [the same ledger's symlink anchor](../decision-evidence/20260805-agent-instruction-restructure-trajectory.md#claude-md-becomes-a-symlink).

## Context and Problem Statement

`20260721-agents-md-single-source.md` made `AGENTS.md` canonical and stated as
a consequence that "context cost per session is bounded (the root file holds
~110 lines)." The file had reached 319 lines. Of those, 177 were the
architecture-decision-record procedure and 17 were coding guidance, so the
material every agent loaded on every turn was mostly governance it would not
use — including agents working v1, which that procedure does not govern.

A separate 44-line `Constitution` section paraphrased `v2/VISION.md`. Both sat
at the top of the same authority order, so any drift between them was both
possible and invisible.

The import mechanism was also tool-specific. `@AGENTS.md` is Claude Code
syntax, while the stated goal of the single-source rule was that one file serve
every agent.

## Decision Outcome

`AGENTS.md` states only what a mechanical check cannot. Where `pnpm lint`
enforces a rule, the file names the check rather than repeating it.

Procedures load on demand as skills. The decision-record procedure lives in the
`decisions` skill with its provenance rules in `references/provenance.md`; the
blind review gate runs through the vendored `cold-read` skill against
`references/questions.md`. This follows the two conventions the repository
already uses — scoped `AGENTS.md` files for always-relevant guidance, skills
with section files for procedures.

The v2 constitution is canonical in `v2/VISION.md` and paraphrased nowhere.

Every `CLAUDE.md` is a symlink to the `AGENTS.md` beside it, replacing the
`@AGENTS.md` import. A symlink is tool-agnostic; the import is not.

## Consequences

The root file drops from 362 lines to 161 while gaining a prerequisites gate
and a verify section that did not exist. (The 319/177 figures above are the
measurement that opened the work; the file grew before this landed.) The decision procedure is absent from
context until an agent touches a record, which is when it becomes relevant.

Prose and enforcement can now disagree in a detectable way: if a check is
deleted, the rule it displaced must return to prose, and the file names each
check so that dependency stays visible.

Skills are checked in under `.claude/skills/`, which required `.gitignore` to
glob `.claude/*` and re-include `skills/`, since a child of an excluded
directory cannot otherwise be re-included.

A tool that reads neither `AGENTS.md` nor a symlinked `CLAUDE.md` sees nothing.
That was already true of the import form, which only Claude Code understood.

