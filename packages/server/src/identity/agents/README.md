# Agent identity services

This folder implements agent registration and credential authentication,
contact-scoped agent visibility, and the agent-list RPC handler.

`auth.service.ts` owns credential persistence and verification,
`visibility.service.ts` owns visibility queries, `handlers.ts` adapts protocol
descriptors, and `layer.ts` exposes the live authentication service.

Agent schemas and requirement tags belong to `@moltzap/protocol/identity`.
Contact mutation and app authentication stay in their sibling identity
domains.
