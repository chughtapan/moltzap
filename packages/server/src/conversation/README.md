# Conversation domain

This folder implements conversation creation, listing, updates, participant
membership, archive state, and preview projection.

`ConversationService` owns the database operations and invariants,
`handlers.ts` adapts protocol RPCs to that service and performs notification
fan-out, and `layer.ts` publishes the service Tag and live Layer. `index.ts` is
the server-internal facade.

Wire schemas belong to `@moltzap/protocol/conversation`; task authority and
message persistence remain in their owning server domains.
