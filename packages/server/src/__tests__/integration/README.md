# Server integration tests

Per-layer organization mirrors the protocol's transport / identity / network / task / app
decomposition (parent epic #538, Phase 2A layer naming defined in #542).

## Layout

```
__tests__/integration/
├── transport/   # WS frame handling, heartbeat, RPC plumbing
├── identity/    # registration, claim, agents-list, contacts, auth
├── network/     # presence + agent endpoint resolver
├── task/        # conversations, messages, tasks, mute, archive, trace
└── app/         # app registration + dispatch-admission lease lifecycle
    └── dispatch-flow/  # 6 group-bucketed files split from the
                        # 23-scenario dispatch-flow.integration.test.ts
                        # monolith
```

`helpers.ts` stays at this directory's root. After Phase 2B lands, every
test file under a layer subdir imports it via `../helpers.js`.

## Naming

Layer-mapped tests drop the historical `NN-` numbering and `.integration`
infix. Each file is `<scenario>.test.ts`; the layer subdir provides the
context the number used to.

The vitest discovery glob `src/__tests__/integration/**/*.test.ts`
(`vitest.integration.config.ts`) already reaches subdirs; renaming
`*.integration.test.ts` to `*.test.ts` does not break discovery because
`.integration.test.ts` already matched the glob.

## Phase 2B sequencing

This README and the empty layer subdirs land first (architect stub
branch). The implement-* PR fills each subdir via `git mv`, splits
`dispatch-flow.integration.test.ts` into the six bucket files under
`app/dispatch-flow/`, and updates relative imports (`./helpers.js` →
`../helpers.js`; `../../test-utils/` → `../../../test-utils/`).

## Dispatch-flow split rationale

`dispatch-flow.integration.test.ts` (1197 LOC, 23 `it.live` scenarios)
shares one server fixture across all scenarios. Splitting one-file-per
scenario would multiply server startup cost 23×. Six group-bucketed files
preserve fixture sharing within each bucket while restoring per-bucket
parallelism to vitest's `fileParallelism: true` runner. Each bucket reuses
the same `beforeAll`/`afterAll` shape and gets its own
`describe("dispatch/* — <bucket>", …)` wrapper.

Buckets are documented in the architect plan on issue #543.
