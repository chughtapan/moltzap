---
name: docs
description: |
  Documentation style and regeneration in this repo — where flow
  diagrams live, the Mermaid dialect GitHub actually accepts, and when to
  run pnpm docs:generate. Load for any docs page edit, adding a
  flow diagram, or touching anything under docs/.
---

# Documentation

Authority order lives in `AGENTS.md → Docs` and governs how to *read* anything.
This is how to *write* it.

## Generated docs

MODULE.md pages, the protocol reference, and constants snippets are generated.
Refresh them **before merge, not per commit**:

```sh
pnpm docs:generate
```

then commit the result. `pnpm docs:check:drift` is the CI backstop.

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

## Style (adapted from OpenClaw)

Adapted from observed documentation patterns at [docs.openclaw.ai](https://docs.openclaw.ai/).

`AGENTS.md`, the installed `google-documentation-guide` skill, and this
skill's source ownership rules take precedence over these patterns.

### Page types

- Guides complete one named task; quickstarts take the shortest supported path.
- Concepts explain entities, ownership, behavior and constraints, linking
  the exact contracts. References support lookup by command, flag or field.
- Troubleshooting starts with an observable symptom or error, then gives a
  diagnostic, healthy result, failure meaning, remedy and verification.

### Page structure

- Mintlify renders frontmatter `title:` as the page H1. Do not repeat it as
  a body H1, even where existing pages do. Start at H2; give a one-line lede.
- Put prerequisites before dependent actions; distinguish user tools,
  credentials, services and prior setup from contributor requirements.
- Number procedure steps by dependency, starting each with an action.
  Keep its command, explanation, success condition and likely failures together.
- Close with `## Next steps` linking useful follow-up tasks, concepts or
  references. Concepts and references need no artificial procedure or empty
  prerequisites section.

### Voice and terminology

- Address the reader as "you"; use imperative actions and present-tense
  behavior with a named acting component. Use plain declarative explanations.
- Define unfamiliar terms on first use and keep one name per concept.
  Preserve exact product names, UI labels, commands, flags, field paths and
  environment variables; distinguish package names from display names.

### Commands and examples

- Use the smallest complete example for a plausible task, with consistent
  names, addresses, ports and paths. State directory, required state and
  replacements first; use safe identities and secret placeholders.
- Make commands copy-pasteable after replacements. Label partial config,
  pseudocode and representative output; show each command's observable result.
  Verify examples against the implementation and public contracts.

### Configuration and CLI reference tables

- Tabulate exact setting paths or argument/option names, types or accepted
  values, requiredness, defaults or omitted behavior, and purpose.
- Give command invocations; explain units, bounds, precedence, validation,
  activation, interactions and failure behavior. Include exit status and
  stdout/stderr where scripts depend on them; separate examples from defaults.
- Link shared conventions and owning specifications. Document actual surfaces,
  with version, platform and installation limits beside affected instructions.

### Avoid

- Avoid architecture tours before first use, exhaustive ledes and duplicate links.
- Keep facts at one canonical owner and preserve incoming links and anchors.
  Keep history in release or migration records. Do not import OpenClaw-specific
  interfaces, release policy or prose verbatim.
