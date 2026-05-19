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

See `packages/server/docs/architecture/10-r-channel-capabilities.md` for the
pattern, migration recipe, and bug classes it catches.

### Shapes

- **Obtain capabilities** query the DB and produce capability + payload row.
  Naming: `obtainXxx(...)` returns
  `Effect.Effect<Xxx["Type"], <ServiceError>, <ServiceTag>>`.
- **Refine capabilities** validate an already-fetched row produced earlier
  in the handler/service. Naming: `refineXxx(row)` returns
  `Effect.Effect<Xxx["Type"], <ValidationError>>`.
- **Composite capabilities** collapse multi-gate authorization paths into a
  single tag whose value is either a discriminated union (when the gates
  have alternative arms — Architect Decisions A, C) or a flat record (when
  the gates are unconditional — Architect Decision D). Effect's R channel
  cannot express "exactly one of N alternative tags must be provided" AND
  composite payloads avoid re-running gates when a short-circuit applies.
  Composites today:
  - `MessageSendPermission` — Decision A; three-arm discriminated union.
  - `ConversationCreateAuthorization` — Decision C (r3); two-arm union
    that preserves the DM-dedup short-circuit. The `ExistingDm` arm
    bypasses policy + capacity gates; `PermittedToCreate` proceeds.
  - `AddParticipantPermission` — Decision D (r3); single flat record
    carrying every gate-proof payload (no short-circuit arm).

### Phase boundary

- **Phase 1** (D1 unblocker, this directory): capability tags + obtain/refine
  helpers + `assertCapabilityMatchesTask` + type-canaries + unit tests.
  No service or handler bodies change. D1's new handlers consume these from
  day one (E ships before D1's PR opens).
- **Phase 2-4** (`task.service.ts`, `conversation.service.ts`,
  `message.service.ts`): existing service methods declare capabilities in
  their R channel and replace `yield* this.requireX(...)` with `yield* Xxx`.
  Handlers add `Effect.provideServiceEffect(Xxx, obtainXxx(...))` wiring.

### Decision B status: package-private `requireX`

The architect plan picked Option A — `requireX` methods stay on the service
class as `@internal` exported methods (no `private` modifier). `obtain*`
helpers in this directory call `requireX` through the service Tag. The TS
`private` modifier would have forbidden DI-injected access regardless of
path; the JSDoc `@internal` + the boundary in this README is the
package-internal convention. See `06-architect-decisions` in the plan.
