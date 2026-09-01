# Endpoint recovery

This directory owns endpoint-local catch-up and Router-restart recovery. It
reconstructs only verified durable state and blocks normal protocol traffic
until the recovered position is safe to use.

Start with `index.ts`. It is the private facade for recovery lifecycle,
catch-up, and ingress coordination. Endpoint callers use that facade, while
the engine and outbound path also share the readiness barrier. Other recovery
modules remain private to this directory.
