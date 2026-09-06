---
name: shared-sdlc
description: Plan, review, or hand off cross-package Social Harness and MoltZap work using scoped records and explicit validation evidence.
---

Resolve the work's scope from `.records/config.json` in `DOCS_INTERNAL_ROOT`.
If the private checkout is unavailable, use the public package contract and state
which internal decisions could not be verified; do not block unrelated work.
Read `program/reference/sdlc.md` for the lifecycle and review routing. Read only
the scope overview and relevant catalog entries, then its public code contracts.

Use one short intent/plan/outcome for routine changes. Durable boundary, trust,
compatibility and ownership choices merit ADRs. Approved design, implementation,
merged code and verified deployment are separate facts. Keep public instructions
usable without private records.

For handoff, record branch, commit, uncommitted state, reviewed candidate,
validation evidence and remaining issue links. Another agent must be able to
continue without this chat. Preserve failed attempts. Report deviations directly.
Use existing gstack and applicable Google skills; do not create duplicate pipelines.
