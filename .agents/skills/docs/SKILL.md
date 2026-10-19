---
name: docs
description: |
  How documentation is written and regenerated in this repo — where flow
  diagrams live, the Mermaid dialect GitHub actually accepts, and when to
  run pnpm docs:generate. Load before writing or editing docs, adding a
  flow diagram, or touching anything under docs/.
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
Use plain declarative sentences without flourishes to explain behavior.
Edit generated files only through their source or producer.

### Page types

- A guide completes one named task for a stated reader. A quickstart takes
  the shortest supported path to one working outcome.
- A concept page explains entities, ownership, behavior and constraints.
  Link the exact contracts that support the explanation.
- A reference page supports lookup by exact command, flag or field name.
  Keep exhaustive interface details out of task procedures.
- A troubleshooting page starts with an observable symptom or error. Give
  a diagnostic, its healthy result, the failure's meaning, a remedy and a
  verification step.

### Page structure

- Give each page a specific title and a one-line lede stating its outcome
  or subject and scope. Use one rendered title in the existing page format.
- Put prerequisites before the first dependent action. Separate required
  tools, credentials, services and prior setup from contributor requirements.
- Use numbered steps for procedures, ordered by dependency. Start each step
  with an action. Keep its command and explanation together.
- Give a verification command and observable success condition. Put likely
  failures beside the affected step and link deeper recovery instructions.
- Close with a `Next` section containing a few descriptive links to useful
  follow-up tasks, concepts or reference entries.
- Adapt the body to the page type. Concepts and references need no artificial
  procedure or empty prerequisites section.

### Voice and terminology

- Address the reader as "you" and use imperative verbs for actions.
- Describe behavior in present tense and name the component that acts.
- Keep sentences short, with one main point. Keep each paragraph on one idea.
- Define unfamiliar terms on first use. Use one name for each concept.
- Preserve exact product names, UI labels, commands, flags, field paths and
  environment variables. Distinguish package names from display names.

### Commands and examples

- Start with the smallest complete example for a plausible task. Keep names,
  addresses, ports and paths consistent across steps.
- State the working directory, required state and replacements before the
  command. Use safe example identities and placeholders for secrets.
- Make commands copy-pasteable after the stated replacements. Omit prompts,
  quote shell-sensitive arguments and continue multiline commands correctly.
- Use language-labelled fences. Separate runnable commands, syntax sketches
  and representative expected output. Label partial config and pseudocode.
- Show expected output or describe the observable result beside each command.
  Verify examples against the implementation and public contracts; resolve
  discrepancies before presenting an example as supported.

### Configuration and CLI reference tables

- Use compact tables for settings: exact field path, type or accepted values,
  requiredness, default or omitted behavior, and purpose.
- State units, bounds, precedence, validation failures and when changes take
  effect beside the table. Distinguish example values from defaults.
- For an existing command, give its purpose and invocation. Tabulate arguments
  and options with exact names, accepted values, requiredness and defaults.
- Explain interactions, effects, success output and failure behavior. Include
  exit status and stdout/stderr behavior where scripts depend on them.
- Link shared conventions and the owning specification. Document only actual
  configuration and CLI surfaces; a template does not establish an interface.
- State version, platform or installation limits beside affected instructions.
  Distinguish supported versions from tested versions when they differ.

### Cross-links

- Link prerequisites, concepts and exact reference entries where needed.
  Use descriptive labels and the repository's supported link paths.
- Keep detailed facts at one canonical owner. Link the constitution and
  public specifications instead of repeating their guarantees.
- Preserve incoming links and anchors when splitting or moving content.
  Add navigation depth only when it improves task discovery.

### Avoid

- Avoid rhetorical questions, fragments, promotional claims, unsupported time
  estimates, conversational filler and decorative emphasis.
- Avoid architecture tours before first use, exhaustive ledes, wide tables,
  duplicate related-link lists and implementation details without reader value.
- Prefer ordinary Markdown. Use existing site components only when they help
  readers choose; keep essential prerequisites and failure conditions visible.
- Keep current usage on task pages and history in release or migration records.
  Do not import OpenClaw-specific interfaces, release policy or prose verbatim.
