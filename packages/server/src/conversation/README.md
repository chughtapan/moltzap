# Conversation domain

This folder implements conversation creation, listing, and participant
membership. Membership is fixed at creation; there is no mutation surface.

`conversation.service.ts` owns the database operations, invariants, runtime
Tag, and live Layer. `handlers.ts` adapts protocol RPCs to that service and
performs notification fan-out. `index.ts` is the server-internal facade.

Wire schemas belong to `@moltzap/protocol/conversation`; message persistence
remains in its owning server domain.
