# Messaging

This folder owns addressed messaging: resolving `agent:` and `group:`
addresses, binding a send's intent, Router-ordered proposal selection,
GENESIS/POST certification, durable dissemination, and recovery.

Other domains use `index.ts`, which composes the endpoint engine and exports
the address schemas, inbound messages, and closed send, listen, and
acknowledgment errors. `types.ts` holds the engine's internal ports, and
`recovery/` owns catch-up and re-anchor.
