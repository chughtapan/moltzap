# Conformance — `app/` layer

Dispatch / lease / app-callback invariants. Every property here
exercises `dispatch/{request, authorize, release}`,
`dispatches/{consumed, expired, get}`, or app-host adversity surfaces
(disconnect, hook-gated delivery, multi-app FIFO, spurious frames).

## Property files

15 dispatch-admission properties plus 5 cross-cutting app properties.
Each `register*` lives in its own file:

- `dispatch-request-ack.ts`
- `dispatch-request-recipient-disconnect.ts`
- `dispatch-authorize-verdict.ts`
- `dispatch-authorize-timeout.ts`
- `dispatch-release-after-resolve.ts`
- `dispatch-release-skipped-on-abandoned.ts`
- `dispatches-consumed-fires-on-first-send.ts`
- `dispatches-consumed-suppressed-on-second.ts`
- `dispatches-expired-fires-on-ttl.ts`
- `dispatches-expired-suppressed-on-consume.ts`
- `dispatches-get-moderator-sees.ts`
- `dispatches-get-non-moderator-rejected.ts`
- `slow-first-does-not-delay-second-ack.ts`
- `same-conv-dispatches-concurrent.ts`
- `release-for-one-lease-does-not-wait.ts`
- `app-disconnect-fail-policy.ts` — stays `PropertyUnavailable`
- `hook-gated-delivery.ts` — tombstone
- `multi-app-fifo-short-circuit.ts` — tombstone
- `spurious-app-callback-frame.ts` — tombstone
- `idempotence.ts`

## Layer-internal driver

`_driver.ts` — the cross-impl `DispatchTestDriver`. All 15
dispatch-admission property files import from it. The leading underscore
names a layer-internal helper (not exported via `index.ts`).

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`APP_PROPERTIES` in the order `_shared/suite.ts` invokes them.

## Tombstones

Three properties retain their `PropertyDeferred` bodies; one stays
`PropertyUnavailable`. `_shared/suite.ts` `allowedServerCoverageGaps`
preserves all four exemptions.
