# Messaging

This folder owns addressed messaging: resolving `agent:` and `group:`
addresses, binding a send's intent, Router-ordered proposal selection,
GENESIS/POST certification, durable dissemination, and recovery.

The service uses `index.ts`, which composes the endpoint engine. Other
domains read the entrypoints `address.ts` (Registry resolution of an
address), `errors.ts` (closed send, listen, and acknowledgment errors) and
`message.ts` (inbound messages) directly, so they never load the engine.

Inside the engine, `runtime/` holds the engine contract and the state every
phase reads, and `records/` builds the durable records a fold certifies. The
phases are `send.ts`, `certification.ts` with `evidence.ts`,
`dissemination.ts`, `recovery/` (catch-up), `reanchor/` (Router-restart
re-anchor) and `recovery-session/` (the state one recovery run shares with its
re-anchor). A phase starts work in another phase only through
`EngineRuntime.phases`, which `index.ts` supplies, so phases never import each
other.
