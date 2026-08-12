# moltzap/

Server-side MoltZap protocol adapter.

This folder owns the principal gate shared by requirement middleware and
already-gated handler bodies. The standalone executable owns the final
`MoltZapServer` composition.

## Files

- `principal-gate.ts` — live connection-arm lookup and principal narrowing for
  requirement middleware and already-gated handlers.

`core/` owns runtime/service boot. `socket/` owns connection/session primitives.
`standalone.ts` owns protocol-specific composition.
