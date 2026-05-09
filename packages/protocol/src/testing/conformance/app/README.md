# Conformance — `app/` layer

Dispatch / lease / app-callback invariants. Every property here
exercises `dispatch/{request, authorize, release}`,
`dispatches/{consumed, expired, get}`, or app-host adversity surfaces
(disconnect, hook-gated delivery, multi-app FIFO, spurious frames).

## Property files

15 dispatch-admission properties carved from `dispatch-admission.ts`,
plus 5 cross-cutting app properties from other monoliths.

| File | Carved from |
|---|---|
| `dispatch-request-ack.ts` | `dispatch-admission.ts` |
| `dispatch-request-recipient-disconnect.ts` | `dispatch-admission.ts` |
| `dispatch-authorize-verdict.ts` | `dispatch-admission.ts` |
| `dispatch-authorize-timeout.ts` | `dispatch-admission.ts` |
| `dispatch-release-after-resolve.ts` | `dispatch-admission.ts` |
| `dispatch-release-skipped-on-abandoned.ts` | `dispatch-admission.ts` |
| `dispatches-consumed-fires-on-first-send.ts` | `dispatch-admission.ts` |
| `dispatches-consumed-suppressed-on-second.ts` | `dispatch-admission.ts` |
| `dispatches-expired-fires-on-ttl.ts` | `dispatch-admission.ts` |
| `dispatches-expired-suppressed-on-consume.ts` | `dispatch-admission.ts` |
| `dispatches-get-moderator-sees.ts` | `dispatch-admission.ts` |
| `dispatches-get-non-moderator-rejected.ts` | `dispatch-admission.ts` |
| `slow-first-does-not-delay-second-ack.ts` | `dispatch-admission.ts` |
| `same-conv-dispatches-concurrent.ts` | `dispatch-admission.ts` |
| `release-for-one-lease-does-not-wait.ts` | `dispatch-admission.ts` |
| `app-disconnect-fail-policy.ts` | `boundary.ts` (stays unavailable; see plan §5) |
| `hook-gated-delivery.ts` | `delivery.ts` (tombstoned; retombstoned to new follow-up) |
| `multi-app-fifo-short-circuit.ts` | `delivery.ts` (tombstoned; retombstoned) |
| `spurious-app-callback-frame.ts` | `rpc-semantics.ts` (tombstoned; retombstoned) |
| `idempotence.ts` | `rpc-semantics.ts` |

## Layer-internal driver

`_driver.ts` — the cross-impl `DispatchTestDriver` (carved verbatim
from legacy `conformance/test-server-driver.ts`). All 15
dispatch-admission property files import from it. Leading-underscore
names a layer-internal helper (not exported via `index.ts`).

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`APP_PROPERTIES` in the order legacy `_shared/suite.ts` invokes them
(delivery → boundary → rpc-semantics → dispatch-admission ordering
preserved within the array).

## Tombstones

Three properties retain their `PropertyDeferred` bodies; one stays
`PropertyUnavailable`. `_shared/suite.ts` `allowedServerCoverageGaps`
preserves all four exemptions verbatim. Disposition decisions are
named in plan §5; refreshed follow-up issues replace stale `#318`
references at implementation time.
