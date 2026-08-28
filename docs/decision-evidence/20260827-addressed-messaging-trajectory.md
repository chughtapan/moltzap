# Addressed messaging decision trajectory

This non-normative ledger compacts the recoverable source events for the
addressed-messaging decision. It does not supply architecture authority.

## Source scope and gaps

The source is the Codex local history for session
`019fd899-779c-7e70-a8e4-338727b13e6c`. Each retained event below cites the
source record's append-only local line and Unix timestamp, converted to UTC.
The history records contain the user submission text, session identifier, and
timestamp. They do not contain native message identifiers, turn identifiers,
parent locators, or an explicit stored actor-role field. The event kind and
role are therefore recorded as `user input`, which is the only kind stored by
this history source; no missing identifier is invented.

The source does not retain the intervening public agent explanations,
structured-choice prompts, structured-choice selections, or the final agent
plan that the user later instructed the agent to implement. Consequently this
ledger does not reconstruct the rationale for canonical sorting, the selected
ordinary-post threshold, or the detailed interface and wire shapes from the
terse `okay` and `Implement the plan.` replies. The named decision-maker must
review those outcomes directly when admitting the ADR. This is a source gap,
not evidence that the omitted material said anything in particular.

Two near-identical user submissions at source lines 2920 and 2921 were stored
60 seconds apart. This compaction retains the first and marks the duplicate as
omitted rather than presenting the same text as two independent decisions.

## Addressed messaging, groups, and shared meetings

### Event 1

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2920
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T18:57:37Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > Cross-conversation context injection was removed. This can significantly
  > affect CoordBench’s multi-DM N4/N10 coordination. <-- we should add this
  > back
  >
  > The messaging interface needs a group chat feature so that the agents can
  > themselves create groups.
  >
  > Individual private cal but shared meetings.

Omission: the duplicated source record at line 2921 and the rest of this long
submission are omitted. The omitted text requested analysis and described the
proposed invite/RSVP motivation; it is not quoted as a separate decision.

### Event 2

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2922
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T19:27:10Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > and lets remove OpenFloorV1 right now. It's not actually being used. It's
  > a projection we can add later.

### Event 3

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2924
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T19:55:09Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > we should reduce our own debt here: try to fallback to existing openclaw
  > and nanoclaw codewhere possible

### Event 4

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2925
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T20:41:17Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > Can we make a major change so for both openclaw and nanoclaw route through
  > one main session. We should just have agent:, and group:?

### Event 5

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2927
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T20:52:54Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > attendees: ["bob@coordbench.invalid", "carol@coordbench.invalid"] instead
  > of this: we should just have agent: addresses, and lets not send automatic
  > notifications. agents may message saying I've sent you an invite.

Omission: the rest of the submission asks how native hosts present an incoming
message. It is omitted because it is a question rather than a decision.

## Native messaging and group visibility

### Event 6

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2930
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T21:29:13Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > One more thing to think about: now that we have shared session style,
  > should we try to see if the message tool thing in openclaw makes more
  > sense? directly reply feels weird right

This event is retained as a question. It does not by itself establish the
answer later carried by the ADR.

### Event 7

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2932
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T21:52:53Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > Should every visible MoltZap message require the host’s native messaging.
  > I don't understand that
  > Also for groups when the recipient gets the message. they should also know
  > it's a group conversation right

This event records a visibility requirement for group delivery and a question
about native messaging. The missing public agent explanation and later
selection are part of the source gap above.

## Compatibility, process, and downstream deferral

### Event 8

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2929
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T21:17:54Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > Don't do coordbench migration in this run. Just write down a HANDOFF for
  > later.
  >
  > Do not worry about backcompat. This is not a goal. Don't overcomplicate
  > rollback or anything like that
  >
  > Make sure new code follows google style, testing, reviewing, and
  > documentation guides ojay.

Omission: the source submission's requested handoff checklist and fresh-state
format bullets are compacted into the handoff and ADR, not duplicated here.

### Event 9

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2936
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T22:21:49Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > which branch are you working against? the new moltzap 4-layer cutover
  > branch right?

This question is retained because the subsequent implementation instruction
was scoped to the four-layer cutover. The missing agent answer is part of the
source gap above.

### Event 10

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2940
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T22:52:08Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > Implement the plan.

The referenced plan is not present in the local history source. This event
therefore establishes an implementation instruction but cannot independently
establish the omitted plan's exact contents.

### Event 11

- Source system: Codex local history
- Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`
- Native locator: unavailable; local history record line 2943
- Enclosing turn and parent locator: unavailable
- UTC timestamp: `2026-08-27T23:54:53Z`
- Stored event kind and actor role: user input; the source has no separate role
  field
- Literal excerpt:

  > ookay, that sounds good. proceed

The source does not retain the directly preceding public agent prompt. This
terse reply is recorded because it followed the discussion of retaining
auditable signature evidence while excluding evidence from logical hashes,
but the missing prompt prevents this record from independently proving what
the reply accepted. The spelling is preserved exactly.
