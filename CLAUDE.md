# moltzap

Workspace-root instructions for Claude. Per-package CLAUDE.md files
under `packages/*/` extend these.

## Architecture documentation

Every published package has an `ARCHITECTURE.md` index and per-flow
detail docs under `docs/architecture/`. Keep them in sync with code
changes:

- **When you change a flow** (request routing, state machine,
  dispatcher logic, lifecycle, error handling, etc.), update the
  corresponding `packages/<pkg>/docs/architecture/NN-<topic>.md` in
  the same PR. The doc is wrong the moment the code drifts from it.
- **When you add a new flow** that warrants its own diagram, create
  a new `docs/architecture/NN-<topic>.md`, link it from the package's
  top-level `ARCHITECTURE.md` index table, and cross-link from any
  sibling docs that reference it.
- **When you add a new published package**, mirror the structure:
  package-level `ARCHITECTURE.md` index (§1 Project Structure, §2
  Public Surface, §3 link table, §4 Dependencies, §5 Tests,
  §6 Glossary) plus per-flow detail docs.

### Code analysis — prefer LSP over Explore for tracing

When tracing how code is wired (definition, references, callers, type
flow, signature evolution), use the LSP first. Explore-style search
agents are read-windowed: they grep a region and stop, so they
will miss content past the window AND miss symbol-aware relationships
(rename targets, implementations of an interface, downstream callers
of a generic method).

LSP, by contrast, is the compiler's own view of the code: every
`go to definition`, `find references`, and `type at cursor` answer is
ground-truth for the current tree. Architects, implementers, and code
reviewers should default to LSP for these questions:

- *Where is `X` defined?* → LSP definition (one hop, type-aware)
- *Who calls `X`?* → LSP references / callers (covers all variants,
  including renamed re-exports)
- *What does this generic `T` resolve to here?* → LSP type-at-cursor
- *Which interfaces does `Y` implement?* → LSP implementations
- *Why does the compiler reject this signature?* → LSP diagnostics at
  point + inferred type

Reserve Explore agents for:

- *Where might this feature be?* (no symbol name yet — pure breadth search)
- *Search for a string literal or comment pattern* (LSP can't help)
- *Tree-wide grep for a regex* (one-shot, accept the read window)

If you find yourself using Explore to answer a "who/what/where" symbol
question, you are paying read-window cost for a question LSP would
answer canonically. Switch.

For agents dispatched via `/safer:*` modalities, this preference is a
hard rule: architect and implement teammates use LSP to trace code
semantics; Explore is opt-in for breadth-only questions.

### Citation style — symbol names, not line numbers

Cite functions/classes/methods by name, never by line. `file.ts:123`
rots at the next refactor; `file.ts → handleFrame` survives because
the symbol is grep-able. For a code block inside a function, use
the enclosing function plus a verbal pointer:
`server.ts → handleFrame, the Match.value dispatch block`.

The only acceptable uses of `file.ts:NNN` are in PR descriptions, code
review comments, and investigation reports — short-lived artifacts
pinned to a specific commit.

### Cross-package DRY

If a flow lives canonically in another package, **link to it**, don't
re-explain it. Example: the dispatch lease FSM lives in `server/06-lease-lifecycle.md`;
channel docs that touch the lease should link there and describe only
their channel-local concerns (projection logic, local state).

### Mermaid diagrams

Diagrams use Mermaid (GitHub renders them natively). Validate locally
before push — GitHub's parser is stricter than many local renderers.
Common patterns that BREAK GitHub's renderer:

- `<br/>` (XHTML) in `sequenceDiagram` message labels → use `<br>` (HTML5)
- `&lt;` / `&gt;` HTML escapes inside `sequenceDiagram` message text →
  use literal `<` `>` (not operators in message position)
- `;` (semicolon) inside `Note over X: ...` text → use `—` or `,`
  (`;` is a statement terminator)
- `<br>` in `participant X as <label>` aliases → strip; move multi-line
  detail to a sibling `Note over X: ...`
- `\n` literal in `stateDiagram` descriptions → use `<br>`
- `<word>` literals in `stateDiagram` descriptions → use `[word]` or
  rewrite into prose under the diagram

Validate via the local parser loop in
`~/.claude/projects/-home-tapanc-moltzap/memory/reference_github_mermaid_gotchas.md`
(no browser needed; uses `mermaid` + `jsdom`).
