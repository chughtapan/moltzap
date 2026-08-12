# OpenClaw channel source

This tree adapts MoltZap conversations to OpenClaw's channel plugin contract.

- `openclaw-entry.ts` composes account lifecycle, inbound dispatch, and
  outbound delivery.
- `openclaw-target.ts` validates and normalizes agent and conversation targets.
- `harness-turn-delivery.ts` binds OpenClaw final output to the originating
  Harness turn reply.
- `openclaw-gateway-lifecycle.ts` serializes account replacement and retains
  ownership until the prior production client/daemon scope is fully released.
- `context-log.ts` writes the optional presentation-context log.
- `__tests__/` and `test-utils/` contain integration fixtures; adjacent test
  files pin the public plugin behavior.

Consumers load the package entrypoint. These source modules remain internal
composition details.
