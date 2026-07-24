# testbed/src/simulator

The society-simulator surface of `@moltzap/testbed`, exported as
`@moltzap/testbed/simulator`. Five public contracts plus the recording
schema (design doc: chughtapan/moltzap#812):

- `run-spec.ts` — the single schema registry: `RunSpec`, materialization,
  spec-hash, condition/role designation (contract 1, data half)
- `run-config.ts` — agent-runner launch contract, `SimulatorRuntime`
  exit signal (contract 1, launch half)
- `environment-mount.ts` — per-agent MCP/skill mounting behind the
  logging proxy (contract 2)
- `world-driver.ts` — per-agent proxied endpoints and connection-level
  fault apply/revert (contract 3)
- `episode.ts` — task injection, logical time, triggers, termination,
  and `run`, the composition root (contract 4)
- `event-log.ts` + `recording.ts` + `attempts.ts` — the single ordered
  event stream, the four-file recording schema with sealing, and the
  attempt state machine with queue/Runner seams (contract 5)
- `ids.ts`, `errors.ts` — shared kernels (branded runtime ids, tagged
  errors with stable `_tag`s)
- `stub-runtime.ts` — scripted hermetic-CI/demo runtime; the `Runtime`
  contract's reference implementation

Shape: tree — `episode.ts`'s `run` is the orchestrator over peer
contract modules; peers never import each other's internals, only the
declared interfaces. The folder imports `../runtime.ts` (the existing
`Runtime` contract, part of contract 1's surface) and nothing else from
the package root.
