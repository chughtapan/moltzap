# Conformance — `app/` layer

Dispatch / lease / app-callback invariants. Every property here
exercises `agent/dispatch/request`, `app/dispatch/authorize`,
`agent/dispatch/released`, `app/dispatch/lease-*`, or app-host adversity
surfaces.

## Property files

14 dispatch-admission properties plus app-disconnect and idempotence.
Each `register*` lives in its own file:

- `dispatch-request-ack.ts`
- `dispatch-request-recipient-disconnect.ts`
- `dispatch-authorize-verdict.ts`
- `dispatch-authorize-timeout.ts`
- `dispatch-release-after-resolve.ts`
- `dispatch-release-skipped-on-abandoned.ts`
- `dispatch-lease-consumed-fires-on-first-send.ts`
- `dispatch-lease-consumed-suppressed-on-second.ts`
- `dispatch-lease-expired-fires-on-ttl.ts`
- `dispatch-lease-expired-suppressed-on-consume.ts`
- `dispatch-lease-get-moderator-sees.ts`
- `slow-first-does-not-delay-second-ack.ts`
- `same-conv-dispatch-requests-concurrent.ts`
- `release-for-one-lease-does-not-wait.ts`
- `app-disconnect-fail-policy.ts` — stays `PropertyUnavailable`
- `idempotence.ts`

## Layer-internal driver

`_driver.ts` — the cross-impl `DispatchTestDriver`. All dispatch
dispatch-admission property files import from it. The leading underscore
names a layer-internal helper (not exported via `index.ts`).

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`APP_PROPERTIES` in the order `_shared/suite.ts` invokes them.
