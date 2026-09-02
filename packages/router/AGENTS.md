# Router package

Extends the workspace-root `AGENTS.md`. The four-layer constitution in
`docs/vision.md`, the current Router ADR outcomes, and `docs/spec/router.md` plus
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
Publication follows `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`: this package publishes in the one-version set.

Run build, typecheck, test, integration, lint, and architecture checks through
`pnpm nx run @moltzap/router:<target>`.
