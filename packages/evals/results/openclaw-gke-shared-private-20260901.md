# OpenClaw GKE shared/private evaluation — 2026-09-01

The evaluated OpenClaw candidate completed all six selected attempts as
assessed results. This is a one-sample behavioral observation, not a claim that
model output is deterministic.

## Candidate

- Source revision: `41cfd6e85468bf66c6bed5eb3c133047b44ba505`
- Controller image:
  `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/controller@sha256:2a167aaade6a289e594dde0df73f5d553d196cc5e367dcf56d8c9d33345d9ff5`
- OpenClaw image:
  `us-central1-docker.pkg.dev/agentic-societies/moltzap-simulator/openclaw-agent@sha256:8ed6722567e22c7fa70ea9c2d4875234957ff8546b4fb8b1d4338dc13fe4e5bd`
- Runtime model: `openai/gpt-5.5`
- Judge policy: `openai-gpt-5.6-sol/v1`, medium reasoning, structured output,
  no tools
- GKE context: `gke_agentic-societies_us-central1-a_moltzap-simulator`
- Artifact bucket: `agentic-societies-moltzap-ledger`
- Cases: EVAL-006, EVAL-010, EVAL-011
- Sample count: one per case and mode

The shared report ran from `2026-09-01T18:12:12.619Z` through
`2026-09-01T18:24:47.539Z`. The private report ran from
`2026-09-01T18:25:10.893Z` through `2026-09-01T18:40:40.232Z`.

## Results

| Case | Shared | Private | Selected evidence |
| --- | --- | --- | --- |
| EVAL-006 | Failed | Failed | The target's gateway output claimed a MoltZap group send, but the peer observed no social action within 300,000 ms. |
| EVAL-010 | Passed | Failed | Shared mode selected the target's group reply about its own MoltZap path. Private mode selected the 300,000 ms peer timeout. |
| EVAL-011 | Passed | Passed | Both modes selected the target's group reply: it identified a group conversation with four participants. |

Final report identities:

- `openclaw-gke-shared-cutover-20260901-02`: 3/3 assessed attempts, plan digest
  `33eab541af9932802ca16bfae3b0b5ac9870b2a10a99e40887c53403dccf0f0f`
- `openclaw-gke-private-cutover-20260901-01`: 3/3 assessed attempts, plan digest
  `6a21237000c9ce0fdce6d469ab106158aed56434e5930660cb4e2031f405e905`

Neither final report contains a `RunFailedAttempt`,
`EvidenceRejectedAttempt`, `JudgingUnavailableAttempt`, or
`LedgerAllocationFailedAttempt`.

## Artifact identities

Each artifact set is independently addressable as
`gs://agentic-societies-moltzap-ledger/<namespace>/ledger/<ledger>/`.
The directory contains `manifest.json`, `records.ndjson`, and
`completion.json`. Manifest and records values below are the SHA-256 digests
from the completed ledger receipt; evidence is the assessed attempt's evidence
digest.

| Mode | Case | Namespace | Ledger | Run ID |
| --- | --- | --- | --- | --- |
| Shared | EVAL-006 | `mz-454e0d68c46b44b0a8b2e3e8cad2cce0` | `aab6e426-3ec9-4a70-a9fd-c5690614bd86` | `d219f020-4d42-443c-b931-25624dd77d8a` |
| Shared | EVAL-010 | `mz-23ddeecc026c42d38c4a8818003c22dd` | `84b04570-3a39-4191-a7ca-70e76bd03af3` | `a35f840c-be94-4e31-8050-3fb190837d3e` |
| Shared | EVAL-011 | `mz-9696b20eb9c145a0938d19f1e0edecc4` | `1b3a139e-6610-4b55-8eca-40c47c827c3e` | `5c388537-7b76-49b5-8ea7-4c865bd57a64` |
| Private | EVAL-006 | `mz-83c3562b3eee49e29103a039232e2b5b` | `ecef3e99-9707-4949-8b55-032ea7629623` | `a8cc5814-26c9-4a0f-a061-8e2a83a9ff74` |
| Private | EVAL-010 | `mz-17f2dca0c47f4749b29dbc7b8980eee4` | `17d73184-41de-4105-9a43-e4bf85f7f5cb` | `0b575da9-cf8d-4528-8ece-309b95663a23` |
| Private | EVAL-011 | `mz-c1d24b285cef452ba99f84d4d87aef26` | `d808b2d4-5aab-437e-93f8-e9cfd9e5f877` | `beea0558-8b93-4d3c-9ecf-2beea2358d08` |

| Mode | Case | Manifest SHA-256 | Records SHA-256 | Evidence SHA-256 |
| --- | --- | --- | --- | --- |
| Shared | EVAL-006 | `fc44d713df0af852d4a17c95f47bfa611d8062fba3e904fdc24783f48eb0f8bd` | `7edf01aae34349d165bea2d06f2a9096317e0e7ebcb31cef7905d88b8811ff4b` | `4f4a8673cc24b2258175f1ed0674440a00a0b39275717d22d59ad8d257d18f5f` |
| Shared | EVAL-010 | `5a295b945731636200c26ddb1010a2ca1db6e34e946dc8bfbaf7b0564c52078b` | `ed72fa996e15d107dee965f99c4100f6ab914fc8092ac87e3f8a8d0ced47259a` | `04a4d2d9ed3b3752a584bf7d962787fdbbc5613286df5b831639f68c59a6ea0b` |
| Shared | EVAL-011 | `635312750b7b59172d5ce31f3c59ee3700620204aa1aeabb7fd949e45b7dbe48` | `752e4c9db687cc95b10581fb426f5cecc0057812fe42e5e7747080b9fb689023` | `208a149c457bd1700fc0e04d5ad06f8f7ee3423fe356f720812f7d7807a9c3bb` |
| Private | EVAL-006 | `4581bf0e1ce3e172b9c1f61000413858b4803eff53734dab4b2a7e2ff8afc1a3` | `1af4f798b314a7bc834a16b61bda617e70a10445d9dca3b96869dd96aff6ffc1` | `b461d841d2b7021863b714d407e98b4625916d5b374a1e7d1611c98116d731ed` |
| Private | EVAL-010 | `11935aad60c63b492c9d8a758ebc59deb897523e2a3e25ce9612f56cbe60232e` | `83c4f457b7cc666e20baecd0e0a4e68fb0060fc1eab2930180f79d6d13309a70` | `20d14b105bb744ace244550cf390c5469c98f2d0b81fe0ffeb0740559b56f8ca` |
| Private | EVAL-011 | `0cac8ec6e9c080a31338561fa7076cf4f2ebc56f84be94812c46197b2b655fb4` | `c37a7471a96dea34cb1b459ba966fc19fb60b19b0990970241341ccc4f82878a` | `50fc8e3f1589f1e34d4bf50ae80067ebd7e8dbea6c4ba10f697f735347978bd5` |

## Implementation defect found and fixed

The first shared run,
`openclaw-gke-shared-cutover-20260901-01`, used source revision
`41b1bcd3b5aa5df5608f48b09071262e1cd7ddc1` and controller digest
`sha256:a9c5d326f85d1ba9425d6bafefc20e97c35a62cf587dc92d5338442a82888b6a`.
EVAL-010 and EVAL-011 were assessed, but EVAL-006 ended as a
`RunFailedAttempt`: the cold support image did not make
`agent-2-evaluation-observer-1` ready within the Simulator controller's
two-minute default.

The evaluation already selected a five-minute runtime startup budget but did
not pass it to the Simulator submitter. Commit `41cfd6e8` forwards that existing
budget as `MOLTZAP_STARTUP_TIMEOUT_MS`. The rerun's live controller Job carried
`MOLTZAP_STARTUP_TIMEOUT_MS=300000`; the formerly failing cold-start cell passed
the old two-minute boundary and completed as an assessed attempt.

Raw SQLite bundles and full transcripts remain local under
`.moltzap/evals/results/`. Completed run ledgers remain in the configured GKE
artifact bucket; this repository retains only this curated report.
