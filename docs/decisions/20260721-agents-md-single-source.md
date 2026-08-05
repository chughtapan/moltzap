---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260805-agent-instructions-progressive-disclosure.md
---

# AGENTS.md is the single source of agent instructions

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-agents-md-single-source).

## Supersession

**Retained:** `AGENTS.md` is the single source of agent instructions, and no
per-tool mirror carries independent content. The Gate 1 freeze applies the same
rule while reconciling agent law with the accepted architecture.

**Replaced:** the `@AGENTS.md` import. `20260805-agent-instructions-progressive-disclosure.md`
makes every `CLAUDE.md` a symlink, because the import syntax is Claude-specific
while the single-source goal was tool-agnostic. That record also supersedes the
~110-line budget stated in Consequences below, and the "organized by concern"
section list, which no longer describes the file.

**Current contract:** `20260805-agent-instructions-progressive-disclosure.md`.

## Context and Problem Statement

Multiple coding agents (Claude, Codex, others) work in this repo.
Instructions had accumulated in CLAUDE.md files as an unorganized mix
of identity, code rules, test rules, and docs hygiene, with stale
claims surviving renames.

## Considered Options

- Per-tool instruction files maintained in parallel.
- CLAUDE.md canonical, AGENTS.md mirroring it.
- AGENTS.md canonical; every CLAUDE.md is exactly `@AGENTS.md`.

## Decision Outcome

Chosen: **AGENTS.md canonical, `@AGENTS.md` everywhere**. Claude
Code's import syntax inlines the nearest AGENTS.md, so one file
serves every agent without drift between mirrors. Files are organized
by concern (root: Project / Constitution / Issues / Code / Tests /
Docs; packages: purpose / Structure / Concepts / Code / Tests /
Docs), package files contain only package-specific deltas (dedupe
upward), and every factual claim must match the tree.

Consequences: one place to edit; context cost per session is bounded
(the root file holds ~110 lines); a rename or refactor obligates an
AGENTS.md truth pass in the same PR.
