# Messaging

This folder owns addressed messaging: resolving `agent:` and `group:`
addresses, binding a send's intent, Router-ordered proposal selection,
GENESIS/POST certification, catch-up, and recovery.

The service uses `index.ts`, which declares the engine contract
(`EndpointEngine`, its errors, and the pending-message value), composes the
endpoint engine, and re-exports `verifyStoredMembership`, the one verifier of a
stored membership row. Other domains read the entrypoints `address.ts` (Registry
resolution of an address and the canonical group address of a fixed
membership), `errors.ts` (closed send, listen, and acknowledgment errors) and
`message.ts` (inbound messages) directly, so they never load the engine.

Inside the engine, `runtime/index.ts` is the kernel: the dependencies an
engine is built from and the state every phase reads. It is deliberately a
single-file folder entrypoint, because every phase depends on it and it
depends on no phase. `history/` builds the durable records a fold certifies
and reads stored history back, and `startup.ts` rebuilds the engine's state
from the store when the engine starts.
The phases are `send.ts`, `certification/` (certification, evidence routing,
and proposals waiting for a missing predecessor), `recovery/` (recovery runs
and catch-up) and `reanchor/` (Router-restart re-anchor). A phase starts work
in another phase only through `EngineRuntime.phases`, which `index.ts`
supplies, or through a port the called phase defines and the caller builds:
recovery builds the `ReanchorRunPort` its re-anchor runs against. Phases never
import each other's internals.

`outbox.ts` builds the `EngineOutbox` port; only `index.ts` imports it.
