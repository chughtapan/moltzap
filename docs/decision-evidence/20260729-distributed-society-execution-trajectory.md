# Distributed society execution source-event ledger

This is a curated, non-normative ledger from Codex session
`019fab08-15ca-7a10-a9af-f2a8441a45f5`, stored at
`rollout-2026-07-28T16-21-02-019fab08-15ca-7a10-a9af-f2a8441a45f5.jsonl`.
Timestamps are UTC.

The source stores a `turn_id` on public messages but no per-user-message ID or
parent locator. User-message locators therefore use session, turn,
`response_item.message`, and exact timestamp. Assistant messages may
additionally carry a native message ID. Each `request_user_input` function call
has a native response-item ID and call ID. Its output carries the same call ID
but no response-item ID. Calls and outputs have no stored actor-role field;
they are identified as assistant-issued function calls and tool results
carrying the user's selection rather than assigned an invented role.

A stored `user` role identifies the source account role; it does not
independently authenticate Tapan Chugh. ADR `decision-makers` fields separately
name the human accountable for the admitted decision.

Excerpts below are literal. Spelling, punctuation, option labels, and hedges
are preserved. For `request_user_input` excerpts, request headers and internal
question IDs are omitted throughout. When separate option `label` and
`description` fields appear on one line, `: ` is added between them as an
explicit display normalization; the field contents themselves are literal.
Unselected options are marked at each event. Function outputs are reproduced
as raw stored JSON. Other omitted portions are marked.

## Source events

<a id="e01"></a>

### E01 — initial scale and dispatch request

Source: Codex; session `019fab08-15ca-7a10-a9af-f2a8441a45f5`;
turn `019fab0d-a1e8-7432-b3f6-a767cff72c52`;
`response_item.message`; `2026-07-28T23:27:05.488Z`; stored role `user`.

> can you take a look at the current simulator: I want to incorporate additional features: being able to scale out the society (e.g,. run 1000-10000) agents maybe over a k8s cluster, so each agent has to be dockerized properly (nanoclaw alread is? openclaw should have existing things we can reuse?), then we want to wait for all the agents to be up and then dispatch a run on that society

<a id="e02"></a>

### E02 — single-run cluster scope selection

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_06958c6a5c95af0e016a693daa9df0819a9faa3ec24acc9761`;
call `call_vlz2QouoKyvTCXhmbDB9Hiny`;
`2026-07-28T23:39:27.783Z`; stored role absent.

> The full version—10,000 production agents, both runtimes, a reusable warm society, durable dispatch control plane, and router high availability—is a multi-system platform; which boundary should the plan target?
>
> Single-run cluster (Recommended): Provision one society for one Society.run, require every agent to be alive at a cohort gate, dispatch the program once, then tear down; stage validation from 100 to 1,000 to 10,000 without router HA or a queue/operator.
>
> [omitted: one unselected option]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:39:43.060Z`; stored role absent.

> `{"answers":{"cluster_scope":{"answers":["Single-run cluster (Recommended)"]}}}`

<a id="e03"></a>

### E03 — strict cohort gate selection

Prompt source: the same session and turn
`019fab0d-a1e8-7432-b3f6-a767cff72c52`;
`response_item.function_call`;
item `fc_057a6133995c1a69016a693e43a3c8819980eae80d81447ea7`;
call `call_PU6nJTGPlpeJ3PATixSc2ef8`;
`2026-07-28T23:42:00.531Z`; stored role absent.

```text
D2 — The current barrier proves each agent became ready once, but an early agent can die while later agents are still starting and the program can still begin. Stakes: a nominal 10,000-agent run may dispatch into a smaller, already-broken society. Recommendation: 2A, because it exactly implements “wait for all agents” and keeps post-dispatch exit policy unchanged. Options differ in semantics, not coverage. <gstack-qid:plan-eng-review-cohort-gate>
```

> 2A Strict gate (Recommended): Human ~3–5d / agent ~1–2h; medium implementation risk, low maintenance. Pros: one bulk router-visible snapshot proves the whole cohort is online; any pre-gate exit aborts with typed evidence and scoped cleanup. Con: adds a cohort-ready phase and batching contract.
>
> [omitted: one unselected option]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:43:52.229Z`; stored role absent.

> `{"answers":{"plan_eng_review_cohort_gate":{"answers":["2A Strict gate (Recommended)"]}}}`

<a id="e04"></a>

### E04 — one Pod per agent selection

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_057a6133995c1a69016a693ed26bc48199aeb15e000da44ff8`;
call `call_BLVj3S8buKd3HTArKU7DqRYQ`;
`2026-07-28T23:44:22.925Z`; stored role absent.

```text
D3 — At 10,000 agents, Kubernetes can either schedule one pod per logical agent or pack many agents into each worker. Stakes: this decides the security and failure boundary, credential isolation, and control-plane load. Recommendation: 3A, because moltzap models faulty or malicious peers and a pod is the cleanest enforceable boundary. Options differ in architecture, not coverage. <gstack-qid:plan-eng-review-agent-isolation>
```

> 3A One pod/agent (Recommended): Human ~1–2w / agent ~3–5h; medium scale risk, moderate maintenance. Pros: isolates credentials/resources and gives exact per-agent status/cleanup; homogeneous cohorts can use indexed Kubernetes owners to avoid 10,000 bespoke manifests. Con: scheduling, image pulls, and API pressure must be capacity-tested.
>
> [omitted: one unselected option]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:44:38.934Z`; stored role absent.

> `{"answers":{"plan_eng_review_agent_isolation":{"answers":["3A One pod/agent (Recommended)"]}}}`

<a id="e05"></a>

### E05 — scale proof deferred behind a small cohort

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_057a6133995c1a69016a693ef9e9b881998853a9407cb9e513`;
call `call_J4GjN5U25rt7aNh4Jo8eY8L9`;
`2026-07-28T23:45:04.450Z`; stored role absent.

```text
D4 — “Supports 10,000 agents” needs a measurable acceptance test: infrastructure scale and live paid model inference fail for very different reasons. Stakes: without separating them, model quotas/cost can mask router or Kubernetes limits. Recommendation: 4A, which still runs the real OpenClaw/NanoClaw images at 10,000 but uses a deterministic model backend for the capacity gate. <gstack-qid:plan-eng-review-10k-acceptance>
```

> 4A Tiered proof (Recommended): Completeness 10/10; human ~1–2w / agent ~4–6h. Pros: certify 10k pods, authenticated connections, strict readiness, sharded dispatch, traffic, and cleanup deterministically; separately run provider-backed cohorts and an opt-in 10k soak. Con: the mandatory gate does not spend 10k real model calls.
>
> 4B 10k live-model gate: Completeness 10/10; human ~1–2w plus recurring cluster/API cost / agent ~4–6h. Pros: strongest end-to-end claim and exercises provider credentials/quotas under full load. Con: expensive, rate-limit-sensitive, nondeterministic, and unsuitable for routine release CI.
>
> 4C Infrastructure only: Completeness 6/10; human ~4–6d / agent ~2–3h. Pros: fastest proof of scheduling and WebSocket scale with cheap stub agents. Con: does not prove the real runtime images, channel boot, or actual dispatch path at 10k.
>
> [no offered option selected; all offered options retained]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:46:37.089Z`; stored role absent.

> `{"answers":{"plan_eng_review_10k_acceptance":{"answers":["None of the above","user_note: defer 4A and 4B scale. lets get to 10 agents first and then scale"]}}}`

<a id="e06"></a>

### E06 — runtime order selected and then narrowed

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_057a6133995c1a69016a693f77286c8199bbebde69fb9241bc`;
call `call_F93WHMlq09jAoc0DyAhop70N`;
`2026-07-28T23:47:09.839Z`; stored role absent.

```text
D5 — OpenClaw has an official OCI image and readiness endpoints; NanoClaw only containerizes its inner agent and still relies on a host Node supervisor, Docker daemon, bind mounts, and host-local OneCLI. Stakes: “both now” is a real NanoClaw runtime redesign, not a packaging task. Recommendation: 5A, so the ten-agent cluster path lands without Docker-in-Docker while NanoClaw follows through the same contract. <gstack-qid:plan-eng-review-runtime-order>
```

> 5B Both in milestone one: Completeness 10/10; human ~3–5w / agent ~1–2d plus integration time. Pros: proves the shared abstraction against both runtimes immediately and delivers mixed societies. Con: NanoClaw’s supervisor, credential gateway, storage, and inner-container backend all join the critical path.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:48:47.862Z`; stored role absent.

> `{"answers":{"plan_eng_review_runtime_order":{"answers":["5B Both in milestone one"]}}}`

Later source: the same session; turn
`019fab21-dbf0-7e13-a425-1fe4f3d4ed3e`;
`response_item.message`; `2026-07-28T23:49:10.920Z`; stored role `user`.

> maybe fine to skip nanoclaw actually

<a id="e07"></a>

### E07 — host selection belongs at the Layer

Prompt source: the same session; turn
`019fab21-dbf0-7e13-a425-1fe4f3d4ed3e`;
`response_item.function_call`;
item `fc_0920a13aac0bab69016a69405fc77881989b6f0aea98861f32`;
call `call_8svCQj0Q0lcCoXCAvWvnQ4p1`;
`2026-07-28T23:51:00.900Z`; stored role absent.

```text
D6 — We need to decide whether a society definition changes when moving from a laptop to Kubernetes. Today `openClawRuntime()` mixes portable agent settings with local-process settings. Stakes: a cluster-specific runtime constructor is simpler initially, but makes deployment mechanics leak into every roster. Recommendation: 6A, matching the existing goal that the same code-first society can run under different host Layers. <gstack-qid:plan-eng-review-runtime-host-api>
```

> 6A Host selected by Layer (Recommended): Human ~4–7d / agent ~2–4h; medium refactor risk, low long-term maintenance. Pros: `openClawRuntime()` stays the portable definition and laptop/Kubernetes choice happens once at the application edge; host-only paths/images move to typed Layer options. Con: refactors the current native driver contract.
>
> [omitted: one unselected option]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:51:31.128Z`; stored role absent.

> `{"answers":{"plan_eng_review_runtime_host_api":{"answers":["6A Host selected by Layer (Recommended)"]}}}`

<a id="e08"></a>

### E08 — in-cluster execution selected before image delivery was rejected

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_0920a13aac0bab69016a6940b2ba988198aa692e2c5a84de15`;
call `call_kBKNKSuKobL0GBjiAOrTK484`;
`2026-07-28T23:52:25.638Z`; stored role absent.

```text
D7 — A code-first `Effect` program cannot be serialized and sent to Kubernetes; some process containing the user’s TypeScript must own `Society.run`. Stakes: where that process lives determines router exposure, cancellation, cleanup, and how a run artifact is distributed. Recommendation: 7A for the queue-free ten-agent milestone; the previously recorded worker Deployment remains the later sweep path. <gstack-qid:plan-eng-review-run-executor-location>
```

> 7A In-cluster run Job (Recommended): Human ~4–7d / agent ~2–4h; low architecture risk, moderate artifact work. Pros: the user’s run image executes beside router/agents with service-account RBAC and survives laptop disconnects; no public router or serialized program is needed. Con: users must build/push an image containing their entrypoint.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-28T23:53:02.053Z`; stored role absent.

> `{"answers":{"plan_eng_review_run_executor_location":{"answers":["7A In-cluster run Job (Recommended)"]}}}`

An image-delivery prompt then offered published OCI images or a development
registry. The result asked for a middle ground. Source:
`response_item.function_call`;
item `fc_0920a13aac0bab69016a6940fece4481988eeeed48d56c0853`;
call `call_WqP6EnOifRZGOfossm0ghezk`;
`2026-07-28T23:53:40.033Z`, with
`response_item.function_call_output` at `2026-07-28T23:54:17.340Z`; stored
roles absent.

```text
D8 — Kubernetes needs pullable, immutable router and OpenClaw images; today the simulator only builds a node-local router image ID and npm releases publish no OCI artifacts. Stakes: without an image pipeline, the cluster feature works only on the author’s machine. Recommendation: 8A, because distribution is part of making the feature usable. <gstack-qid:plan-eng-review-oci-distribution>
```

> 8A Publish OCI images (Recommended): Completeness 10/10; human ~3–5d / agent ~2–3h. Pros: release-correlated GHCR images for linux/amd64 and arm64, digest pinning, SBOM/provenance, and smoke-tested pulls; deployments are reproducible. Con: expands release CI and registry retention/signing maintenance.
>
> 8B Dev registry only: Completeness 5/10; human ~1–2d / agent ~1h. Pros: fastest cluster prototype and avoids release-workflow changes. Con: every user must build/push/tag images manually, provenance drifts from npm versions, and CI cannot validate the shipped path.
>
> [no offered option selected; all offered options retained]

> `{"answers":{"plan_eng_review_oci_distribution":{"answers":["None of the above","user_note: is there a middle ground?"]}}}`

A revised prompt proposed a narrow GHCR path. Source:
`response_item.function_call`;
item `fc_0920a13aac0bab69016a6941365ec88198ac5f30bc60e2720a`;
call `call_3h2fN9RbMNfHtgcZBpqhWQvN`;
`2026-07-28T23:54:35.801Z`, with
`response_item.function_call_output` at `2026-07-28T23:54:55.532Z`; stored
roles absent.

```text
D8 revised — Which image-delivery boundary should milestone one use? Recommendation: 8R-A, the narrow published path: enough to make the ten-agent run reproducible without taking on a full multi-platform supply-chain program. <gstack-qid:plan-eng-review-oci-distribution-middle>
```

> 8R-A Narrow GHCR (Recommended): Completeness 8/10; human ~2–3d / agent ~1–2h. Publish router and OpenClaw linux/amd64 images only, version/SHA tags plus immutable digests, PR build/smoke tests, and release-only pushes. Defer arm64, Helm, signing-key operations, and retention automation.
>
> [omitted: two unselected options]

> `{"answers":{"plan_eng_review_oci_distribution_middle":{"answers":["8R-A Narrow GHCR (Recommended)","user_note: openclaw images already exist?"]}}}`

The next direct user message replaced the per-experiment-image direction.
Source: the same session; turn
`019fab28-1728-7c10-a698-dea61ec3a188`; `response_item.message`;
`2026-07-28T23:55:59.396Z`; stored role `user`.

> I'm not satisfied with this. lets see how do other simulators / runners handle this problem? OCI images is too much when we are experimentng

<a id="e09"></a>

### E09 — alternative schedulers and hostile isolation

Source: the same session and turn; `response_item.message`;
`2026-07-28T23:57:18.132Z`; stored role `user`.

> and if there are alternatives to k8s too? like maybe slurm or something

An isolation prompt then offered logical, process, or per-agent container/VM
isolation. Source: `response_item.function_call`;
item `fc_0da43edb15a8c13e016a69434ebca8819aa6862564dba431d5`;
call `call_tXHyt9h5gRSENevaJjtzMb0g`;
`2026-07-29T00:03:30.476Z`, with
`response_item.function_call_output` at `2026-07-29T00:03:38.281Z`; stored
roles absent.

> What isolation should the normal experimental path guarantee between agents?
>
> Hostile OS isolation: Give every agent a container or VM boundary because its tool/code execution is mutually untrusted; this makes Kubernetes, Nomad, or equivalent isolation a core cost.
>
> [omitted: two unselected options]

> `{"answers":{"agent_isolation":{"answers":["Hostile OS isolation"]}}}`

Direct source: the same session and turn; `response_item.message`;
`2026-07-29T00:03:38.313Z`; stored role `user`.

> I don't want to support that cheating. I want one container per agent

<a id="e10"></a>

### E10 — Temporal, GCP, Kubernetes, and the base image

Sources: the same session and turn; `response_item.message`; stored role
`user`.

At `2026-07-29T00:05:05.799Z`:

> what about other alternatives like temporal or sometihng?

At `2026-07-29T00:07:01.108Z`:

> gcp? we have a gcp account

Source: the same session; turn
`019fab37-ced4-7b41-8e9c-37c3822a7342`;
`response_item.message`; `2026-07-29T00:13:09.639Z`; stored role `user`.

> what about gke + temporal + bullmq

At `2026-07-29T00:14:21.664Z`, the same locator shape and stored role:

> or general kubernetes; we start with basic OpenClaw image and we can deliver instructions to connect to moltzap over the principal channel (which should work directly with the base image); increases the latency per experiment but that's the gold standard path

At `2026-07-29T00:16:16.056Z`:

> if it can't thats a bug: having this image can be an optimization but not a requirement; and honestly if we use GKE or barebones K8s we can actually point them to a private registry?

<a id="e11"></a>

### E11 — Temporal and Kueue without BullMQ

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_0de0f61a4ee77942016a6946f25f248198abcaf500dba31a35`;
call `call_SnFa3x3617eQul6H1zPNZeCm`;
`2026-07-29T00:19:00.774Z`; stored role absent.

> Which queueing model should the implementation plan lock in?
>
> Temporal + Kueue (Recommended): Temporal owns durable run/sweep lifecycles, Kueue admits cluster capacity, and no Redis queue is added.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:19:34.352Z`; stored role absent.

> `{"answers":{"run_queue_model":{"answers":["Temporal + Kueue (Recommended)"]}}}`

<a id="e12"></a>

### E12 — local Temporal first

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_0de0f61a4ee77942016a694748b20c8198a03dc8a2cc382d04`;
call `call_mbMK8n64ZfjzAGVA69nzjhIw`;
`2026-07-29T00:20:26.953Z`; stored role absent.

> Where should the production Temporal control plane live?
>
> Local first, defer prod: Use the local Temporal dev server for the first milestones and leave production hosting deliberately unselected.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:21:21.293Z`; stored role absent.

> `{"answers":{"temporal_hosting":{"answers":["Local first, defer prod"]}}}`

<a id="e13"></a>

### E13 — GKE first with a future Nomad seam

Direct source: the same session and turn; `response_item.message`;
`2026-07-29T00:21:32.064Z`; stored role `user`.

> what about nomad

Prompt source: `response_item.function_call`;
item `fc_0de0f61a4ee77942016a6947d73c74819884f9cbbb56bb1b18`;
call `call_ydmkVDV3cH2OJqGOwP5lykJz`;
`2026-07-29T00:22:49.257Z`; stored role absent.

> How should Nomad affect the first implementation?
>
> GKE first, Nomad seam (Recommended): Implement Kubernetes/Kueue now, but make the scheduler boundary explicit and prove a Nomad adapter can fit later.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:23:08.182Z`; stored role absent.

> `{"answers":{"scheduler_priority":{"answers":["GKE first, Nomad seam (Recommended)"]}}}`

<a id="e14"></a>

### E14 — regional GKE Standard

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_085a68cab9869c30016a6949146958819bbab92386ffb9ab67`;
call `call_8Tj66rC9ATIk5wZqXIiFtRia`;
`2026-07-29T00:28:04.980Z`; stored role absent.

> Which GKE profile should the plan make authoritative?
>
> Standard regional (Recommended): Use a pre-sized dedicated agent node pool for predictable 1k–10k cohort admission and tuning.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:28:15.312Z`; stored role absent.

> `{"answers":{"gke_profile":{"answers":["Standard regional (Recommended)"]}}}`

<a id="e15"></a>

### E15 — in-cluster controller

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_03af0e485983a38c016a6949a132748198bad70cd7d46a1e18`;
call `call_0HQBCkj6yDpE4i7yXzEsTp8g`;
`2026-07-29T00:30:27.347Z`; stored role absent.

> Where should the experiment’s Effect program execute?
>
> In-cluster controller (Recommended): A stable controller image fetches the content-addressed experiment bundle, owns the router/barrier, and runs close to all agents.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:31:56.397Z`; stored role absent.

> `{"answers":{"program_location":{"answers":["In-cluster controller (Recommended)"]}}}`

<a id="e16"></a>

### E16 — readiness-only proof at scale

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_01ef7ec7a9575e40016a694ac37190819a884a3a6d190792a3`;
call `call_wRLlUZ7Rp3rJDisqqXUr9KmJ`;
`2026-07-29T00:35:18.128Z`; stored role absent.

> How should agent containers receive model-provider access for the gold path?
>
> Readiness-only at scale: Run real model calls only at smaller sizes; 1k–10k validates stock OpenClaw bootstrap, connectivity, and dispatch without LLM turns.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:36:23.505Z`; stored role absent.

> `{"answers":{"model_auth":{"answers":["Readiness-only at scale"]}}}`

<a id="e17"></a>

### E17 — CLI and library target

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_01ef7ec7a9575e40016a694b45fbc4819a9cd320993250ff56`;
call `call_0OO9tWVFfZHYPNu61PoPXcqN`;
`2026-07-29T00:37:27.742Z`; stored role absent.

> How should an experimenter submit a distributed code-first run?
>
> CLI + library (Recommended): Provide a `moltzap simulator run <entrypoint>` command backed by a reusable TypeScript submission API.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:38:23.511Z`; stored role absent.

> `{"answers":{"submission_surface":{"answers":["CLI + library (Recommended)"]}}}`

<a id="e18"></a>

### E18 — Terraform and Helm

Prompt source: the same session and turn;
`response_item.function_call`;
item `fc_01ef7ec7a9575e40016a694c46e220819aab3b103f556a8982`;
call `call_z5VtaeUzaAe4BaD0DJh3UnVU`;
`2026-07-29T00:41:44.786Z`; stored role absent.

> How should the first GKE/Artifact Registry/Kueue environment be provisioned?
>
> Terraform + Helm (Recommended): Make cluster, IAM, registry, storage, node pools, and pinned Kueue installation reproducible.
>
> [omitted: two unselected options]

Result source: the same call; `response_item.function_call_output`;
`2026-07-29T00:43:35.416Z`; stored role absent.

> `{"answers":{"gcp_iac":{"answers":["Terraform + Helm (Recommended)"]}}}`

<a id="e19"></a>

### E19 — agent-authored consolidated plan

Source: the same session and turn;
`response_item.message`;
message `msg_01ef7ec7a9575e40016a694dd2f358819aa37de449f615596e`;
`2026-07-29T00:48:46.754Z`; stored role `assistant`; phase
`final_answer`.

> [omitted: `<proposed_plan>` wrapper and `## Summary` heading]
>
> # Distributed OpenClaw Societies on GKE
>
> - Preserve the invariant: one logical agent equals one Kubernetes Pod with exactly one OpenClaw container.
> - Use regional GKE Standard with Kueue plain Pod groups for the first backend. Kueue admits the cohort together and does not recreate failed plain Pods. MoltZap remains authoritative for semantic readiness. [Kueue plain Pods](https://kueue.sigs.k8s.io/docs/tasks/run/plain_pods/)
> - Use Temporal for one coarse workflow per society run; omit BullMQ. Start with the persistent local Temporal dev server and defer production hosting.
> - Run the experiment Effect inside an in-cluster controller. Experiments are content-addressed GCS bundles, never per-experiment images.
> - Support the stock, digest-pinned OpenClaw image as the mandatory path. A channel-preinstalled image remains an optional optimization.
>
> [omitted: most of `## Simulator and Runner Interfaces`]
>
> - Add bulk registration/readiness to `Router`; one presence RPC observes the full expected identity set rather than polling once per agent.
> - Create `@moltzap/simulator-runner`, exporting Effect-based `bundle`, `submit`, `status`, and `cancel` APIs plus:
>
> [omitted: proposed CLI commands and remaining interface details]
>
> ## Distributed Execution
>
> [omitted: experiment bundle compilation and upload]
>
> - One stable controller image:
>   - downloads and verifies the bundle;
>   - mounts one run PVC for the filesystem ledger and PGlite;
>   - starts the MoltZap server as a scoped child process;
>   - exposes enrollment and MoltZap HTTP/WebSocket traffic through a run-specific TLS endpoint and ClusterIP Service;
>   - runs the experiment Effect and uploads finalized ledger artifacts to GCS.
> - The controller creates `N` homogeneous bare Pods with deterministic index metadata, `restartPolicy: Never`, one container, no init containers or sidecars, and one Kueue Pod-group identity. Disable partial admission, preemption, requeue, and Spot capacity.
> - Each Pod uses a zero-RBAC per-run ServiceAccount and an explicitly projected, short-lived, Pod-bound token. Enrollment performs TokenReview, verifies the live Pod UID/index/spec digest, and returns only that agent’s MoltZap credential and configuration. Same-UID retries are idempotent; any second UID for an index aborts the run.
> - The stock OpenClaw container executes the mounted bootstrap script, downloads the verified channel tarball, installs it with OpenClaw’s supported `npm-pack:` flow, writes its profile/workspace, then `exec`s the normal gateway. [OpenClaw plugin installation](https://docs.openclaw.ai/cli/plugins), [official container and readiness contract](https://docs.openclaw.ai/install/docker)
> - Pre-gate Pod exit, deletion, duplicate index, enrollment failure, Kueue eviction, or startup timeout deletes the whole group and fails acquisition. After `AgentRosterReady`, exits remain typed ledger evidence and customer Effect policy decides whether to end the run.
> - A controller crash fails the run without resume or agent replacement. Temporal performs idempotent cleanup; Pod active deadlines and a cluster janitor prevent orphaned cost.
>
> [omitted: Temporal workflow detail]
>
> ## GCP and Performance Work
>
> - Add Terraform plus pinned Helm configuration for:
>   - regional, VPC-native GKE Standard with Dataplane V2;
>   - a small system pool and dedicated homogeneous on-demand agent pool;
>   - Workload Identity, least-privilege controller RBAC, private GCS buckets, Artifact Registry Docker/npm repositories, logging, Pod CIDRs, Kueue ResourceFlavor/ClusterQueue, topology-aware scheduling, and the janitor.
> - Mirror the official OpenClaw digest into private Artifact Registry; GKE’s node service account receives repository-scoped reader access. Generic Kubernetes remains compatible through ordinary registry credentials. [Artifact Registry and GKE](https://docs.cloud.google.com/artifact-registry/docs/integrate-gke)
>
> [omitted: submission preflight and performance-refactor details]
>
> ## Test and Acceptance Plan
>
> - Kernel tests: mixed scalar/cohort rosters, early exit, never-ready timeout, duplicate UID/index, exact-set gate, event ordering, post-gate exit policy, interruption, and cleanup without false termination evidence.
>
> [omitted: fake-Kubernetes, Kind, and GKE-smoke test bullets]
>
> - Staged manual gates: 100, 1,000, 5,000, then 10,000 real OpenClaw containers. The 1k–10k tests stop at bootstrap, exact readiness, and program dispatch; they do not fan out paid model calls.
> - Acceptance requires zero agent restarts/replacements, `ProgramStarted` only after all expected identities are simultaneously visible, unchanged agent/controller image digests across experiment-only edits, and full quota/node/namespace cleanup.
>
> ## Assumptions and Defaults
>
> - NanoClaw, BullMQ, a Nomad adapter, multi-router sharding, controller recovery, and production Temporal hosting are out of scope.
> - Nomad compatibility is retained through the generic cohort/scheduler boundary; GKE/Kueue is the only initial implementation.
>
> [omitted: remaining assumptions and defaults and `</proposed_plan>` wrapper]

Accepted v2 outcomes translate four parts of this agent-authored proposal:

- “Kueue admits the cohort together” becomes complete aggregate-quota
  admission, not a guarantee of simultaneous physical Pod placement.
- The proposed Router registration and presence operations are not retained.
  The controller, testbed, and endpoint state establish the exact readiness
  gate; Router has no roster or runtime-readiness semantics.
- The controller-owned umbrella MoltZap server becomes independent Registry,
  Router, and Ledger processes plus one independently supervised daemon per
  AgentId.
- The stock-image bootstrap installs and verifies the version-matched
  `moltzap-agentd` executable and OpenClaw adapter, but does not start the
  daemon. OpenClaw `startAccount` starts and supervises the daemon and acquires
  the sole turn-ready bridge subscription over loopback MCP. Neither path
  gives the runtime a v1-style direct channel to an umbrella server or Router
  authority.

The proposed seventh `@moltzap/simulator-runner` package is also not retained
because v2 has an exact six-package boundary. These are repository-law
reconciliations of an agent proposal, not source evidence about the
accountable human's rationale.

<a id="e20"></a>

### E20 — stored-user instruction to apply the ADR process

Source: the same session; turn
`019faf50-4761-7363-9494-a844667f3e7e`;
`response_item.message`; `2026-07-29T19:19:16.229Z`; stored role `user`.

> checkout a new worktree and we will work there, update to v2, realize all these decision and plans as ADRs and then we will discuss first implementation scope. you have to follow the new ADR process

## Decision linkage

<a id="20260727-code-first-simulator-kernel-lineage-correction"></a>

### Code-first simulator kernel lineage correction

No source event has been located for the original
`20260727-code-first-simulator-kernel.md` outcome. Its
[source-gap report](./20260729-code-first-simulator-kernel-source-gap.md)
records that absence. [E20](#e20) instructs the working session to update to
v2 and follow the new ADR process; it does not state the original outcome's
rationale or separately select the lineage correction.

The current candidate marks that record partially superseded because its v1
package, process, and mechanism ownership conflicts with the later accepted v2
package and simulator-system-driver decisions. This is a mechanical
authority-lineage correction, not a reconstruction of a missing source event.

<a id="20260729-one-container-per-agent-gates-distributed-runs"></a>

### One container per agent gates distributed runs

The initial scale/barrier request is [E01](#e01), and the single-run scope is
selected in [E02](#e02). The strict-gate and one-Pod selections are
[E03](#e03) and [E04](#e04). The [E05](#e05) output defers the scale proof
behind a small cohort, [E07](#e07) records the host-at-Layer selection, and
[E09](#e09) states the one-container invariant directly. The consolidated
agent proposal is [E19](#e19), and [E20](#e20) instructs the working session
to realize the decision set as ADRs.

The Router-visible mechanism named in [E03](#e03) is not retained because
current v2 law gives Router no presence or runtime-readiness semantics. The
selected strict-barrier guarantee is retained at the simulator/testbed
boundary.

<a id="20260729-kubernetes-kueue-admits-agent-cohorts"></a>

### Kubernetes and Kueue admit agent cohorts

Kubernetes and alternative-scheduler exploration appears in [E01](#e01),
[E09](#e09), and [E10](#e10). Temporal plus Kueue is selected in
[E11](#e11), GKE-first with a Nomad seam in [E13](#e13), regional Standard in
[E14](#e14), and Terraform plus Helm in [E18](#e18). The consolidated agent
proposal is [E19](#e19), followed by the ADR-process instruction in
[E20](#e20).

No source event selects a Slurm, managed-batch, Autopilot, or initial Nomad
implementation. A GCP Batch question was presented and aborted without an
answer; it is omitted from the outcome rather than interpreted.

<a id="20260729-temporal-orchestrates-distributed-runs"></a>

### Temporal orchestrates distributed runs

The single-run lifecycle is selected in [E02](#e02). Temporal and GCP are
raised in [E10](#e10). The selection outputs record Temporal plus Kueue
without BullMQ in [E11](#e11), local Temporal with production hosting deferred
in [E12](#e12), an in-cluster controller in [E15](#e15), readiness-only proof
at scale in [E16](#e16), and CLI plus library as the eventual submission
surface in [E17](#e17). The consolidated proposal and subsequent ADR-process
instruction are [E19](#e19) and [E20](#e20).

The queue/operator-free detail in [E02](#e02) is superseded by the later
Temporal selection in [E11](#e11); the one-run lifecycle remains.
The in-cluster location selected in [E15](#e15) is retained without its
proposed controller ownership of the Router. The accepted controller acquires
the independent production processes and cohort through testbed Layers.
Per-slot daemon/runtime readiness remains endpoint and harness state; the
exact-roster barrier remains controller and private-kernel state; Router owns
neither.

The source does not assign the CLI/library target to a package compatible with
the current exact export map. Package, export, and binary ownership remains an
explicit implementation-scope gap.

<a id="20260729-openclaw-experiments-are-late-bound"></a>

### OpenClaw experiments are late-bound

The image-per-experiment direction is selected and then rejected in
[E08](#e08). The stock-image gold path, optional optimized image, and private
registry are direct user events in [E10](#e10). The OpenClaw-only narrowing is
the later event in [E06](#e06). The agent consolidates the content-addressed
bundle and stock-image contract in [E19](#e19), followed by the ADR-process
instruction in [E20](#e20).

No retained source event selects the exact package-manager command, bundle
format, cache policy, or GCS path.

<a id="20260729-pod-attestation-gates-agent-enrollment"></a>

### Pod attestation gates agent enrollment

The hostile isolation and one-container boundary are [E09](#e09). The
Pod-bound token, TokenReview, live UID/index/spec check, same-UID idempotency,
and duplicate-UID abort are agent-authored proposals in [E19](#e19). The
stored-user instruction to realize the decisions and plan as ADRs is
[E20](#e20). The ADRs separately name the accountable decision-maker.

No earlier retained user event independently selects those enrollment
mechanisms or states a rationale for them. E20 directs their treatment in the
ADR process; their engineering detail originates in the agent proposal.

## Candidate repository effects frozen

The semantic candidate was frozen on branch
`architect/v2-society-execution` by commit
`26e81c8175dff900151c755ab9f63c778377ff77` (tree
`ede6a829a9f564a8f5bd86405a3ce082225d0383`) at
`2026-07-29T21:43:21Z`. Its sole parent and v2 base is
`0508955433b59f98ca3315b5631eb23ffa907cb1`. The commit contains the five
linked ADRs, the normative distributed-execution chapter, architecture
orientation, decision and specification index updates, the pre-existing
simulator ADR lineage correction, this compacted trajectory, and its recorded
source gap.

A following trace-only commit may add this mechanical event to the trajectory.
That trace commit changes evidence about the semantic freeze, not the frozen
semantic decisions themselves. The exact trace commit is the candidate supplied
to blind review so a cold reader receives both the decisions and their frozen
repository identity.

## Source gaps and omissions

- The public exchange and selections above are retained. Hidden model
  reasoning, system prompts, tool research payloads, machine credentials, and
  irrelevant repository inspection are omitted.
- The source stores no per-user-message ID or parent locator. None is invented.
- The exact Kueue plain-Pod settings, Pod attestation protocol, GKE topology,
  and controller failure mechanics originate in the agent-authored plan. E20
  directs its treatment in the decision process but does not provide a
  separate human rationale for each mechanism.
- The final agent plan was written against v1. Current v2 law independently
  requires the translation recorded above: separate Registry, Router, Ledger,
  and per-AgentId daemons; readiness outside Router; and exactly six packages.
- No direct stored-user message or selection independently chooses exact
  TypeScript APIs, event tags, resource sizes, timeout defaults, Terraform
  module layout, Temporal production hosting, or the first implementation
  slice. E19 proposes symbols and timeout defaults; accepted v2 outcomes do
  not retain them. Production Temporal hosting and the first implementation
  slice remain explicit deferrals.
- No retained source event selects a direct Pod-to-Pod NetworkPolicy posture.
  The candidate leaves that security boundary for the implementation-scope
  decision rather than inferring it from the one-container selection.
