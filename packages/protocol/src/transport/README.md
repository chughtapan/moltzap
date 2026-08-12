# Transport primitives

This is the protocol package's lowest, content-neutral layer.

- The definition module binds method names to parameter, result, requirement,
  notification, and error schemas.
- Strict decoding, typed dispatch, and the mux adapt those contracts to
  `@effect/rpc`.
- Notification subscribers, pagination, wire-string helpers, and shared
  transport and wire errors support every higher protocol domain.

Identity, conversation, and message semantics do not belong here.
External consumers use the curated `rpc.ts` and domain facades; direct
transport imports are for protocol internals.
