# Router package

Extends the workspace-root `AGENTS.md`. The four-layer constitution in
`v2/VISION.md`, the current Router ADR outcomes, and `docs/spec/router.md` plus
the Router representation chapters govern this package.

`@moltzap/router` owns opaque message delivery, the volatile global feed,
polling, cursors, Router instance identity, authenticated Router HTTP, the
Router process, and `moltzap-router`. Its only production workspace dependency
is `@moltzap/identity`.

Router remains content-blind and volatile. It does not own conversations,
membership semantics, certified history, persistence, replay, catch-up,
re-anchor policy, tasks, norms, trust, institutions, or runtime MCP behavior.
It never queries a product Ledger or privileged governance service.

Preserve the admitted wire bytes, routes, bounds, authentication, ordering,
typed failures, and process behavior unless their governing authority changes.
Publication and version policy remain deferred, so the package stays private.

Run build, typecheck, test, integration, lint, and architecture checks through
`pnpm nx run @moltzap/router:<target>`.
