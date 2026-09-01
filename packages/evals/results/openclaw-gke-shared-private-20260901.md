# OpenClaw GKE shared/private evaluation — 2026-09-01

The merge candidate completed all six selected attempts as assessed results.
This is a one-sample behavioral observation, not a claim that model output is
deterministic.

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

- `openclaw-gke-shared-cutover-20260901-02`: 3/3 assessed attempts
- `openclaw-gke-private-cutover-20260901-01`: 3/3 assessed attempts

Neither final report contains a `RunFailedAttempt`,
`EvidenceRejectedAttempt`, `JudgingUnavailableAttempt`, or
`LedgerAllocationFailedAttempt`.

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
