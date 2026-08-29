# Endpoint recovery

This directory owns endpoint-local catch-up and Router-restart recovery. It
reconstructs only verified durable state and blocks normal protocol traffic
until the recovered position is safe to use.

Start with `index.ts`. It is the private facade for recovery lifecycle,
catch-up, and ingress coordination. Its supporting capabilities are:

- `barrier.ts`, the independently shared readiness guard used by the engine
  and outbound path;
- `state.ts`, the active in-memory recovery run;
- `store.ts` and `store-evidence.ts`, verified reconstruction from the endpoint
  store; and
- `reanchor/`, threshold Router-instance reconciliation, including the
  empty-history foundation case.

Endpoint callers use `index.ts`, except for the readiness guard's two direct
consumers. Recovery support files remain private to this directory.
