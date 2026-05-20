## `app/capabilities/`

**Status: STUBS (architect plan #606 / spec #601). Bodies land in Phase 1 impl-staff PR.**

R-channel capability tokens for privileged service methods. Each capability
is a nominal `Context.Tag` whose value carries the runtime IDs + already-
fetched payload row that today's `requireX` runtime check fetches. Privileged
service methods declare capabilities in their R channel; handlers `provide`
the capability via an `obtain*` smart constructor. The compiler enforces the
"call site obtained the capability" obligation; the obtain helper performs
today's runtime check exactly once per request and supplies the typed token
+ payload for re-use inside the body.

See `packages/server/src/app/capability-providers.ts` (file-level
JSDoc) for the pattern, migration recipe, and bug classes it catches.

### Shapes

- **Obtain capabilities** query the DB and produce capability + payload row.
  Naming: `obtainXxx(...)` returns
  `Effect.Effect<Xxx["Type"], <ServiceError>, <ServiceTag>>`.
- **Refine capabilities** validate an already-fetched row produced earlier
  in the handler/service. Naming: `refineXxx(row)` returns
  `Effect.Effect<Xxx["Type"], <ValidationError>>`.
- **Composite capabilities** (currently `MessageSendPermission`) collapse
  intersection-with-alternative authorization paths into a single tag whose
  value is a discriminated union, because Effect's R channel cannot express
  "exactly one of N alternative tags must be provided" (Architect Decision A
  in #606; see `message-send-permission.ts` header for the rationale).

### Cutover status

- **Phase 1** (capability primitives, this directory): capability tags +
  obtain/refine helpers + `assertCapabilityMatchesTask` + type-canaries +
  unit tests. Live; D1's new handlers consume the primitives directly.
- **Phase 2** (`task.service.ts`): all 10 public methods declare the
  capability in their R-channel and consume the value via `yield* Tag`
  + a one-line `assertCapabilityMatchesTask` defensive guard. Handlers
  in `tasks.handlers.ts` wire `Effect.provideServiceEffect(Tag,
  obtainTag(...))`. Live.
- **Phase 3-4** (`conversation.service.ts`, `message.service.ts`): NOT
  YET cut over. The public methods retain the pre-Spec-E inline-gate
  shape (call the renamed `@internal` `assertX`/`loadX` helpers
  directly). The obtain helpers are in place; the cutover is blocked
  on a structural split of `conversation.service.ts` (file currently
  sits at the `max-lines: 1050` lint cap, leaving no headroom for the
  additional R-channel signature plumbing).

### Decision B status: package-private gate helpers

The architect plan picked Option A — gate helpers stay on the service
class as `@internal` exported methods (no `private` modifier). `obtain*`
helpers in this directory call those gate helpers through the service
Tag. The TS `private` modifier would have forbidden DI-injected access
regardless of path; the JSDoc `@internal` + the boundary in this README
is the package-internal convention. See `06-architect-decisions` in the
plan. Per Spec E (#601) cutover, the helpers were renamed from the
`requireX` prefix to `assertX` / `loadX` so the audit grep over
`packages/server/src/**/*.ts` returns 0 `require[A-Z]` hits.
