# Agent identity services

This folder implements agent registration and credential authentication and
the agent-list RPC handler.

`auth.service.ts` owns credential persistence and verification, `handlers.ts`
adapts protocol descriptors, and `layer.ts` exposes the live authentication
service.

Agent schemas and requirement tags belong to `@moltzap/protocol/identity`.
App authentication stays in its sibling identity domain.
