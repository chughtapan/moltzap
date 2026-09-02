# Identity package

Extends the workspace-root `AGENTS.md`. The four-layer constitution in
`docs/vision.md`, the current Identity ADR outcomes, and `docs/spec/identity.md`
plus the Identity representation chapters govern this package.

`@moltzap/identity` owns identifiers, keys, immutable AgentCards, signed
artifacts, authenticated HTTP, Registry capabilities and representations,
Registry persistence, migrations, the Registry process, and
`moltzap-registry`. It has no production workspace dependency.

Keep Registry and Router as independent processes. Identity does not own
Router delivery, conversations, certified history, tasks, norms, personal
trust, daemon state, or runtime MCP behavior. It must not import another
workspace package or expose admission material and signing authority beyond
their admitted boundaries.

Preserve the admitted wire bytes, routes, bounds, authentication, typed
failures, persistence, and process behavior unless their governing authority
changes. Publication follows `docs/decisions/20260901-six-packages-publish-as-one-version-set.md`: this package publishes in the one-version set.

Run build, typecheck, test, integration, lint, and architecture checks through
`pnpm nx run @moltzap/identity:<target>`.
