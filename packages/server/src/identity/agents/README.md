# Agent identity services

This folder implements agent registration and credential authentication and
the agent-list RPC handler.

`auth.service.ts` owns credential persistence, verification, and its live
service layer. `handlers.ts` adapts protocol descriptors.

Agent schemas and requirement tags belong to `@moltzap/protocol/identity`.
App authentication stays in its sibling identity domain.
