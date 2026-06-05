# Server integration tests

Per-layer organization mirrors the protocol's transport / identity / network / task / app
decomposition (parent epic #538, Phase 2A layer naming defined in #542).

## Layout

```
__tests__/integration/
├── transport/   # WS lifecycle, heartbeat, RPC plumbing
├── identity/    # registration, claim, agents-list, contacts, auth
├── network/     # presence + agent endpoint resolver
├── task/        # conversations, messages, tasks, mute, archive, trace
└── app/         # app registration + dispatch-admission lease lifecycle
    └── dispatch-flow/  # 6 group-bucketed files split from the
                        # 23-scenario dispatch-flow.integration.test.ts
                        # monolith
```

`helpers.ts` lives at this directory's root. Tests under a layer subdir
import it via `../helpers.js`; tests under `app/dispatch-flow/` import
via `../../helpers.js`.

## Naming

Layer-mapped tests drop the historical `NN-` numbering and `.integration`
infix. Each file is `<scenario>.test.ts`; the layer subdir provides the
context the number used to.

The vitest discovery glob `src/__tests__/integration/**/*.test.ts`
(`vitest.integration.config.ts`) already reaches subdirs; renaming
`*.integration.test.ts` to `*.test.ts` does not break discovery because
`.integration.test.ts` already matched the glob.

## Dispatch-flow split rationale

The original `dispatch-flow.integration.test.ts` (1197 LOC, 23 `it.live`
scenarios) shared one server fixture across all scenarios. Splitting
one-file-per scenario would multiply server startup cost 23×. Six
group-bucketed files under `app/dispatch-flow/` preserve fixture sharing
within each bucket while restoring per-bucket parallelism to vitest's
`fileParallelism: true` runner. Each bucket file owns its own copy of
the imports + module state + `beforeAll`/`afterAll`/`beforeEach` triad
and gets its own `describe("dispatch/* — <bucket>", …)` wrapper.

Buckets are documented in the Phase 2B architect plan on issue #543.
