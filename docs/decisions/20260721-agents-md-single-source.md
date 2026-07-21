---
status: accepted
date: 2026-07-21
decision-makers: Tapan Chugh
---

# AGENTS.md is the single source of agent instructions

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
