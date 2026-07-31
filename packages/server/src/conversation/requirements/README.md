# conversation/requirements/

Obtain helpers and guards backing the conversation-domain authority checks.
A protocol descriptor names the authority it needs in its `requires` list; the
obtain functions here resolve that authority against the server's services, and
the guards refine an already-fetched row inside a handler body.

## Boundary

These modules may read `ConversationServiceTag`, `MessageServiceTag`, and
`TaskServiceTag`. They never broadcast, never mutate, and never reach into
transport. A requirement that needs no server service is a pure guard in
`@moltzap/protocol` instead.

## Files

### Obtains — resolve a requirement tag for the middleware layer
- `send-access.ts` — `ConversationSendAccess` obtain: proves the caller
  participates, then loads the joined row every send guard reads. Also carries
  `guardTaskActive`, the handler-body refinement over that row.
- `in-task.ts` — `ConversationInTask` obtain: proves a conversation belongs to
  the named task.

### Authority checks — called directly from handler bodies
- `app-ownership.ts` — `assertCallerAppOwnsConversation`: compares the calling
  AppConnection's appId against the conversation's routing key.
- `create-authorization.ts` — `authorizeConversationCreateCapacityOnly`: the
  capacity gate for conversation creation.

## Shape

Obtains return the requirement's value type and fail with the tag's declared
`failure` schema, so the middleware layer in
`moltzap/auth-middleware-layers.ts` can wire them without a cast. Guards take
the already-loaded row as a value: no read, no service environment.
