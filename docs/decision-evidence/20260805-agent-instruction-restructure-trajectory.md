# Agent-instruction restructure, 2026-08-05

This is a non-normative source-event ledger. It records located source events
and repository effects; it does not supply missing rationale or infer intent.

## Source manifest

- **S1** — Claude Code session; session `01UHzrYnz4gqSZKQnkNBVyKa`; surfaced to
  the compacting agent as conversation turns rather than as a stored JSONL
  archive.

### Source gaps, stated rather than filled

The compacting agent was a participant in S1 and had no access to its stored
archive. Consequently:

- **No native message IDs.** Events below are located by turn ordinal within
  S1, in the order they occurred. Turn ordinals are the compacting agent's
  numbering, not a source-assigned identifier.
- **No UTC timestamps per event.** The session date (2026-08-05) is known;
  per-message times are not. No timestamp is invented.
- **No parent locators**, for the same reason.

Excerpts are literal, preserving spelling, punctuation, and hedges. Every
omission is marked `[omitted: …]`. Agent proposals are recorded as agent
events and repository changes as separate mechanical events.

<a id="agents-md-progressive-disclosure"></a>

## Agent instructions move to progressive disclosure

- Source event — S1; turn 1; stored role `user`:

  > hi! the progress on this project is getting too slow. can you look at the
  > qm project from ycombinator and see how their agents.md is organized and
  > lets see what we can import here?

- Agent event — S1; turn 1 response; role `assistant`. Reported measurements
  of the then-current `AGENTS.md`: 319 lines total, 177 in the architecture
  decision records section, 17 across Code and Tests. Reported that the
  `Constitution` section paraphrases `v2/VISION.md` lines 71–166.

- Source event — S1; a later turn; stored role `user`:

  > docs/agent-law/ again? .claude/ is maybe fine, we can update the gitingore
  > to be more precise

- Source event — S1; the next turn; stored role `user`, replying to the agent's
  question about where the split-out files should live:

  > why are they law and not skills or prompts or whatever? look at what the
  > actual conversion is.

  [omitted: the agent's preceding AskUserQuestion offering three directory
  layouts, retained in S1 but not reproduced here; the reply is
  uninterpretable without knowing it proposed `.claude/agent-law/`,
  `.agents/`, and `AGENTS/`.]

- Agent event — S1; following turn; role `assistant`. Reported that the
  repository already splits agent instructions two ways: scoped `AGENTS.md`
  files per package, and skills with section files (`gstack
  plan-eng-review/sections/`, QM `deploy-qm/references/`). Proposed that the
  decision-record material is a procedure and therefore belongs in a skill,
  and that no new top-level directory is needed.

- Source event — S1; a later turn; stored role `user`:

  > delete things which are already into the arch linters etc now

<a id="claude-md-becomes-a-symlink"></a>

## CLAUDE.md becomes a symlink

- Source event — S1; turn 3; stored role `user`:

  > 1,2,3 are okay. come up with proposal. also split out stuff for managing
  > differnet aspects into different subsections? and I also like using
  > symlinks for CLAUDE.md insted of claude doing @agents.md

  [omitted: `1,2,3` refers to three imports the agent had listed in the
  immediately preceding turn — graduated review depth, explicit
  no-permission defaults, and affected-tests-only verification.]

<a id="adr-point-corrections"></a>

## Point corrections to admitted records

- Mechanical event — repository. During the `scripts/` reorganization
  (PR #967), a blanket path rewrite modified
  `docs/decisions/20260721-v2-lives-top-level.md`, which names the boundary
  check by path. The agent reverted that edit before landing, citing the
  never-silently-rewrite rule.

- Source event — S1; a later turn; stored role `user`:

  > docs/decisions/20260721-v2-lives-top-level.md -- I'm fine to update this
  > with an explicit changelog at the bottom. that's also worth adding for only
  > point changes like this. the ADR process should allow for that. vocabs,
  > paths, don't require large ADRs but they do require changelogs so future
  > reconcillioation can find that.

- Mechanical event — repository. `AGENTS.md` gained a rule permitting a point
  correction with a dated `Record changelog` row, and
  `20260721-v2-lives-top-level.md` gained the first such row, in commit
  `c66119fd` on PR #967.

<a id="scripts-organized-by-domain"></a>

## Scripts grouped by domain

- Source event — S1; a later turn; stored role `user`:

  > scripts should also start becomign organized instead of being a dump

- Source event — S1; the following turn; stored role `user`:

  > and maybe organize the scripts by role rather than whatever? docs/,
  > docs/adr, server? whatever

- Mechanical event — repository. PR #967 grouped `scripts/` into
  `architecture/`, `code/`, `docs/`, `release/`, `repo/`, `setup/`, `test/`,
  and `lib/`, and added `check-script-reachability.ts`.

<a id="prerequisites-are-a-refusal-gate"></a>

## Prerequisites are a refusal gate

- Source event — S1; a later turn; stored role `user`:

  > and you want to make sure that AGENTS.md mentions the required skills or
  > refuses to work. nx, effect, gstack, everythign else we disccused

- Mechanical event — repository. PR #969 added
  `scripts/repo/check-agent-setup.sh` and the `AGENTS.md` refusal table.
