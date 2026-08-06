# Evidence relocation, 2026-08-05 through 2026-08-06

The record this ledger supported,
`20260806-evidence-lives-in-the-brain.md`, failed its blind review at
candidate `86fd3f09` and was withdrawn. The events below are retained because
they happened; no decision they describe is admitted.

This is a non-normative source-event ledger. It records located source events
and repository effects; it does not supply missing rationale or infer intent.

## Source manifest

- **S1** — Claude Code session; session `01UHzrYnz4gqSZKQnkNBVyKa`; surfaced to
  the compacting agent as conversation turns rather than as a stored JSONL
  archive.

### Source gaps, stated rather than filled

The compacting agent was a participant in S1 and had no access to its stored
archive. Consequently there are **no native message IDs** (events are located
by turn ordinal, which is the compacting agent's numbering rather than a
source-assigned identifier), **no per-event UTC timestamps** (the session dates
are known; per-message times are not, and none is invented), and **no parent
locators**.

Excerpts are literal, preserving spelling and punctuation. Every omission is
marked `[omitted: …]`. Agent proposals are recorded as agent events and
repository changes as separate mechanical events.

<a id="evidence-moves-to-the-brain"></a>

## Evidence moves to the brain

- Source event — S1; stored role `user`:

  > I'ma also actully okay to migrate the compaction things into something like
  > a sqlite db or something? there is also the traces project that we can look
  > at? we don't have to keep that stuff in plaintext. and it should be only
  > accessible to the collaborators on the project actualy like the nx cachce

- Agent event — S1; following turn; role `assistant`. Reported that
  `docs/decision-evidence/` was 504K against a 31.8 MiB pack, that a scan of all
  artifacts found 0 email addresses, 1 non-GitHub URL, 7 `/Users/tapanc` paths,
  and 690 session UUIDs, and that the repository is public. Reported that Agent
  Trace (Cognition, 2026-01-29; Cursor RFC) specifies code attribution and
  "intentionally does not define a storage mechanism," addressing neither
  privacy nor access control. Recommended a derived SQLite index built from the
  markdown rather than a migration.

- Source event — S1; stored role `user`:

  > but we are adding extra compaction cost too

- Agent event — S1; following turn; role `assistant`. Reported that the three
  sessions cited by the foundational v2 trajectory —
  `bcba8e38-c0b9-42f9-af6b-6deda9655478`,
  `a3c74293-d31a-48de-8b36-e05ca97e989d`, and
  `19cdb5cb-a6e1-4514-8b82-e9e1e1313cc2` — were absent from
  `~/.claude/projects`, which held 165 JSONL files and 137M. Revised the
  recommendation to separate mechanical preservation from selective compaction.

- Source event — S1; stored role `user`, on where the brain should live:

  > Supabase, auto-provision (Recommended)

  [omitted: the agent's preceding AskUserQuestion offering four options —
  Supabase auto-provision, PGLite local, Supabase with an existing URL, and a
  remote gbrain MCP.]

- Mechanical event — repository. gbrain 0.42.73.2 installed; a Supabase project
  provisioned in `us-west-1`; `gbrain init` reported
  `{"status":"success","engine":"postgres","pages":0}` with 120 migrations
  applied. The repository imported at 256 pages, then 964 after a code sync.

- Agent event — S1; role `assistant`. Reported that searching the brain for
  reviewer-verdict language returned three quarantined records, including
  `20260805-agent-instructions-1dd2ef47-cold-review` with its blockers and
  per-question verdicts, and that this is the same exposure that voided the
  second blind review of `282c333c`.

- Source event — S1; stored role `user`:

  > I want trajectories also to move to supabase right? that's what we discussed

- Agent event — S1; following turn; role `assistant`. Reported that
  `scripts/docs/adr/check-shape.ts` verifies provenance with `existsSync`
  against the repository path, that ~70 files reference `decision-evidence/`,
  and that `GBRAIN_SEARCH_EXCLUDE` hides pages from search but is defeatable
  through `include_slug_prefixes`.

- Source event — S1; stored role `user`, on whether gbrain may remain optional:

  > wI thinkn gbrain is required

- Source event — S1; the next turn; stored role `user`:

  > not optional

- Source event — S1; stored role `user`, on the CI credential:

  > add the secret

- Source event — S1; the next turn; stored role `user`:

  > forks break is fine

- Mechanical event — repository. `GBRAIN_DATABASE_URL` added as a repository
  secret; `ci.yml` passes it to `pnpm lint`; the `gbrain, connected` row added
  to the `AGENTS.md` prerequisites table; `check-agent-setup.sh` fails without
  it. Landed in PR #975.
