---
name: docs
description: |
  How documentation is written and regenerated in this repo — where flow
  diagrams live, the Mermaid dialect GitHub actually accepts, and when to
  run pnpm docs:generate. Load before writing or editing docs, adding a
  flow diagram, or touching anything under docs/.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Documentation

Authority order lives in `AGENTS.md → Docs` and governs how to *read* anything.
This is how to *write* it.

## Generated docs

MODULE.md pages, the protocol reference, and constants snippets are generated.
Refresh them **before merge, not per commit**:

```
pnpm docs:generate
```

then commit the result. `pnpm docs:check:drift` is the CI backstop.

Per-commit regeneration was tried and removed: the `docsGeneration` named input
in `nx.json` covers every `.ts` file under `packages/`, so any TypeScript edit
invalidates the cache and the target runs in full — measured at 150s, on every
commit. The cache is correct and practically never hits, which is why no amount
of input tuning fixes it.

Never hand-edit a generated file. `docs/snippets/constants/values.json` carries
a `generatedBy` field naming its producer; edit the producer.

## Flow diagrams

Flow diagrams are Mermaid in JSDoc above the owning symbol. Generated MODULE.md
pages surface them, so the diagram lives with the code it describes and cannot
drift into a separate document.

Change a flow → update its diagram in the same PR.

Cross-package flows are documented **once**, at the canonical owner. Elsewhere,
link by symbol name rather than restating the diagram — a second copy is a
second thing to forget.

## Mermaid, GitHub-strict

`pnpm docs:check:mermaid` enforces this, so treat the list as an explanation of
failures rather than something to memorize:

- `<br>`, never `<br/>`
- literal `<` and `>`, not HTML entities
- no `;` inside `Note` text — it terminates the note
- no `<br>` or parentheses in participant aliases
- `<br>`, not `\n`, in `stateDiagram`
- no bare `<word>` literals

These are GitHub's renderer, not Mermaid's spec: a diagram that previews
correctly in an editor can still fail on GitHub.

## Citations

Cite by symbol name (`file.ts → handleFrame`), never by line. `file.ts:NNN` is
for PRs and reviews, which are snapshots; a line number in a long-lived
document rots at the next refactor.
