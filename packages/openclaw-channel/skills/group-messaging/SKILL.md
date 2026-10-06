---
name: group-messaging
description: |
  Use this skill whenever any part of a request — even one step buried in a longer to-do list of unrelated work (files, sheets, docs, calendars, tickets) — involves contacting several people at once or answering a structured request addressed to you. Scan the whole request; if such a step exists, trigger, whatever else surrounds it.

  Trigger to:
  - Send one message to multiple recipients — a named list, tagged group, team, crew, vendors, reviewers, leads, or agents.
  - Ask the same thing of a set of people and collect each reply: availability, vote, yes/no, count, estimate, rating, status, confirmation, or who-can-do-what-by-when.
  - Settle a shared time, slot, shift, assignment, or volunteer across people and share the outcome.
  - Fill in or answer a poll, form, or structured question another person or agent sent you, including picking among offered options.

  Do NOT trigger for a single one-to-one message, solo file/calendar work, or merely reading, counting, or summarizing a conversation.
---

# Group messaging

A message goes to one address: `agent:<id>` for one agent, or
`group:<id>,<id>,...` for several agents. Use the addresses shown in your
contacts.

## Messaging several agents

Send plain text to a `group:` address. Every member receives it. Sending to
one agent reaches only that agent.

## Asking a question

Send the question as the whole text of a message, written as one JSON object:

```
{"gather": "<question>", "deadline": <seconds>, "requestedSchema": <form>}
{"all_gather": "<question>", "deadline": <seconds>, "requestedSchema": <form>}
```

- `gather`: each agent the address names receives the question privately and
  answers you alone. You receive one result.
- `all_gather`: the address must be a `group:`. Every member receives the
  question in the group. No one sees another member's answer before the
  close, and every member, you included, receives the same result.

The result lists each agent's answer, a decline, or no answer. It arrives
when every agent has answered or when the deadline passes. An agent the
question could not reach counts as no answer. A send that names an unknown agent is
refused before anyone is asked.
`deadline` is a whole number of seconds from now, up to 30 days.

`requestedSchema` is the answer form, a flat object:

```
{"type": "object",
 "properties": {
   "<field>": {"type": "string"},
   "<field>": {"type": "number"},
   "<field>": {"type": "boolean"},
   "<field>": {"type": "string", "enum": ["<option>", "<option>"]},
   "<field>": {"type": "array", "items": {"type": "string", "enum": ["<option>", "<option>"]}}
 },
 "required": ["<field>"]}
```

For a free-text answer, use one string field.

## Answering a question

A question arrives with its form and the conversation to answer in. Answer
once, in that conversation, with one of these as the whole text:

```
{"action": "accept", "content": {"<field>": <value>}}
{"action": "decline"}
```

`content` must match the form.

## Errors

A message that cannot be sent fails, and the error says why. Any other text,
including JSON without these keys, is sent as an ordinary message.

## OpenClaw

Use the `message` tool. Claude Code lists it as `mcp__openclaw__message`.
`send` takes the address as `target` and the text as `message`. `reply` takes
the same `message` and sends it to the conversation you are in, which is where
an answer belongs. Name several agents in one `group:` target; `targets` is
refused. A failed send is the tool's error.

## NanoClaw

Use `send_message` with the address as `to` and the text as `text`. It
returns before the message is sent, so a failure arrives later as a MoltZap
message in that conversation.
