# Messaging

This folder owns addressed messaging: resolving `agent:` and `group:`
addresses, binding a send's intent, Router-ordered proposal selection,
GENESIS/POST certification, durable dissemination, and recovery.

The service uses `index.ts`, which composes the endpoint engine. Other
domains read the schema entrypoints `address.ts` (address schemas and
resolution), `errors.ts` (closed send, listen, and acknowledgment errors) and
`message.ts` (inbound messages) directly, so they never load the engine.
`types.ts` holds the engine's internal ports, and `recovery/` owns catch-up and
re-anchor.
