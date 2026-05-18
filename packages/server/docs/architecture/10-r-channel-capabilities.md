# R-channel capabilities

> **Status: outline only.** Phase 1 implement-staff (#601) fills the H2 sections below.
> Plan: [architect plan #606](https://github.com/chughtapan/moltzap/issues/606). Spec: [#601](https://github.com/chughtapan/moltzap/issues/601).

This doc explains the typed-capability pattern that moved `requireX`-style
runtime authority checks into Effect's `R` channel. It is the canonical
reference for "how do I add a capability?" and "why is my handler missing
a `provideServiceEffect` call?".

## 1. The bug class this catches

H2 to fill (Phase 1 implement-staff): describe the "forgot to call
`yield* this.requireTmAuthority(...)`" production bug class, including
the historical incidents the pattern guards against. Reference the
spec's "Intent" section verbatim.

## 2. Two capability shapes

H2 to fill: contrast **obtain** (queries DB, returns payload + token)
vs **refine** (validates an already-fetched row) shapes. Include code
snippets from `tm-authority.ts` (obtain) and `task-active.ts` (refine).

## 3. The composite capability path (`MessageSendPermission`)

H2 to fill: document why MessagesSend uses a single composite tag with
a discriminated value-union instead of the spec's `(TaskActive |
TmAuthority) & (ValidReplyTarget | NoReplyTarget)` union-of-tags shape.
Cite the `capability-r-channel.types-check.ts` canary as the load-bearing
evidence. Reference Architect Decision A in plan #606.

## 4. Migration recipe — adding a capability to an existing method

H2 to fill (Phases 2-4): step-by-step recipe.
1. Define the tag + obtain helper in `app/capabilities/`.
2. Promote any consumed `requireX` to `@internal` exported on the
   service class (Decision B / Option A).
3. Service method: add the tag to its R channel, replace
   `yield* this.requireX(...)` with `yield* MyTag` + a one-line
   `assertCapabilityMatchesTask` check.
4. Handler: add `Effect.provideServiceEffect(MyTag, obtainMyTag(...))`.
5. Type-canary update if the new tag participates in a union-shape
   semantics (rare; usually only for MessagesSend's composite).

## 5. Decision B — `requireX` visibility (`@internal` exported)

H2 to fill: document the Option A decision (package-private exported
methods + JSDoc `@internal`) and why TS `private` was insufficient
(DI cannot bypass `private`, but the service class itself is constructed
in `app/layers.ts`; `obtain*` helpers in `app/capabilities/` need
access). Reference architect plan #606 Decision B.

## 6. State-proof staleness (open question Q1 in the spec)

H2 to fill: liveness-proof composability — refine-shape capabilities
(`TaskActive`, `ConversationNotArchived`) are valid only within a
single transaction. Document the staleness window contract; reference
the JSDoc convention.

## 7. What's NOT in the R channel (yet)

H2 to fill: Tier 5 identity (`Authenticated`) — explain why caller
agent ID stays as a method parameter (workspace-wide blast radius);
reference Spec E §Non-goals #5 + open question Q3.

## 8. Cross-references

- Capability primitives: `packages/server/src/app/capabilities/`
- Service-layer composition: [01-service-layer-composition.md](./01-service-layer-composition.md)
- Request → response handling (where `defineXxxMethod` lives):
  [03-request-response-handling.md](./03-request-response-handling.md)
- Layer-tag hierarchy:
  `packages/server/src/transport/layer-tags.ts`
