# Runtime address spelling decision trajectory

This non-normative ledger compacts the recoverable source events for the
runtime address spelling decision. It does not supply architecture authority.

## Source scope and gaps

The source is the Codex local history for session
`019fd899-779c-7e70-a8e4-338727b13e6c`. Each retained event below cites the
source record's append-only local line and Unix timestamp, converted to UTC.
The history records contain the user submission text, session identifier, and
timestamp. They do not contain native message identifiers, turn identifiers,
parent locators, public agent responses, or an explicit stored actor-role
field. The event kind and role are therefore recorded as `user input`, which
is the only kind stored by this history source; no missing identifier is
invented.

The source does not retain the public agent response that selected the leading
`@` form after the user delegated that choice. A later terse `yes` is omitted
because its directly preceding agent prompt is unavailable and the reply has
no independently recoverable meaning. The retained delegation is literal; the
ledger does not reconstruct the missing response or infer additional
rationale.

## Agent address sigil selection

### Event 1

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 3123
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-09-01T06:10:04Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > also I think agent:xx should be use @xx or xx@ whichever one you prefer?

### Event 2

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 3125
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-09-01T06:12:59Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > ship. re-run and work make sure these evals pass

This event is retained as the implementation instruction following the address
discussion. It supplies no unstated syntax, compatibility, or protocol
rationale.
