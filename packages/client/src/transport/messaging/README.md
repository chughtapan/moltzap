# Messaging

This folder owns addressed messaging: resolving `agent:` and `group:`
addresses, binding a send's intent, Router-ordered proposal selection,
GENESIS/POST certification, durable dissemination, and recovery.

The service uses `index.ts`, which declares the engine contract
(`EndpointEngine`, its errors, and the pending-message value) and composes the
endpoint engine. Other domains read the entrypoints `address.ts` (Registry
resolution of an address), `errors.ts` (closed send, listen, and
acknowledgment errors) and `message.ts` (inbound messages) directly, so they
never load the engine.

Inside the engine, `runtime/index.ts` is the kernel: the dependencies an
engine is built from and the state every phase reads. It is deliberately a
single-file folder entrypoint, because every phase depends on it and it
depends on no phase. `records/` builds the durable records a fold certifies.
The phases are `send.ts`, `certification/` (certification, evidence routing,
and the dissemination resume), `recovery/` (catch-up), `reanchor/`
(Router-restart re-anchor) and `recovery-session/` (the state one recovery run
shares with its re-anchor). A phase starts work in another phase only through
`EngineRuntime.phases`, which `index.ts` supplies, so phases never import each
other.

`outbox.ts` is the engine's outbox and the only caller of the outer-envelope
signers, so every outer body the engine originates is built and signed there.
Outside a recovery run it stages each signed envelope in the durable outbox and
keeps the ordered queue the Router worker transmits; a running recovery hands
its signed envelopes to the worker's recovery queue instead. Only `index.ts`
imports it; phases reach it through `EngineRuntime.outbox`.
