# Eval bundles

Bundle form of the 16 scenarios in `../scenarios`. A bundle is a `RunSpec`
plus a `grade:` section: `moltzap-testbed run` reads the spec half and never
sees `grade:`, and a grader reads `grade:` and the sealed recording.

`../scenarios/*.yaml` stay as they are. `EVAL-005.yaml` in particular is the
pinned cc-judge compat fixture and is byte-frozen; every bundle here is a
sibling of its scenario, never a replacement.

## Two forms per scenario

| Path | Target runtime | What it measures |
|---|---|---|
| `EVAL-*.bundle.yaml` | `openclaw` | agent behaviour; needs model credentials |
| `hermetic/EVAL-*.hermetic.bundle.yaml` | `stub` (`echo` script) | the instrument; runs with no model credentials |

The two differ in exactly one place: the target agent's `runtime` block, and
the `condition.label` suffix that keeps their recordings from being read as
one comparable set. Everything else — steps, rubric, `contentVersion` — is
identical, so a hermetic run exercises the same episode the real-model run
will.

## How a scenario becomes steps

`episode.steps` is an ordered list of speech acts. A step either starts a task
(`with:` names the participants alongside the speaker) or speaks into the
conversation an earlier named step started (`into:`). `awaitReplyFrom:` holds
a step until the named agent has answered the previous one, which is what
keeps a probe from landing before the fact it probes for was ingested.

| Old payload | Steps |
|---|---|
| `kind: direct` | one `start` by `eval-sender`, plus one `send` per `followUpMessages` entry |
| `kind: cross` | one `start` by `eval-sender`, then one `start` by `eval-probe-sender` |
| `kind: group`, speaking bystander | the bystander's `start` (it is a principal), then `eval-sender` sends into it |
| `kind: group`, silent bystanders | one `start` whose `with:` lists the bystanders, which are `stub`/`quiet` agents |

A one-step episode completes on `replies{from, minCount}`. Every longer one
completes on `last-step-answered`, because a predicate that counts traffic can
fire before a later step is spoken and seal a run that proves nothing.

## The server image digest

`server.imageDigest` pins the image `packages/testbed/scripts/build-server-image.mjs`
builds. That script is content-addressed over the workspace, so the digest
moves whenever `@moltzap/server-core` or `@moltzap/protocol` change. Re-derive
it with:

```bash
node packages/testbed/scripts/build-server-image.mjs
```

and rewrite the `server.imageDigest` line, or export
`MOLTZAP_SIM_SERVER_IMAGE` to pin one outright.
