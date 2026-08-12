# conversation/requirements/

Obtain helpers backing the conversation-domain authority checks. A protocol
descriptor names the authority it needs in its `requires` list; the obtain
functions here resolve that authority against the server's services.

## Boundary

These modules may read `ConversationServiceTag` and `MessageServiceTag`. They
never broadcast, never mutate, and never reach into transport. A requirement
that needs no server service is a pure guard in `@moltzap/protocol` instead.

## Files

### Obtains — resolve a requirement tag for the middleware layer
- `send-access.ts` — `ConversationSendAccess` obtain: proves the caller
  participates and that the conversation row still exists.

### Authority checks — called directly from handler bodies
- `create-authorization.ts` — `authorizeConversationCreateCapacityOnly`: the
  capacity gate for conversation creation.

## Shape

Obtains return the requirement's value type and fail with the tag's declared
`failure` schema, so the middleware layers in `standalone.ts` can wire them
without a cast.
