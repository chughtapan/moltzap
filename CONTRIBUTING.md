# Contributing to Social Harness

This page covers what an outside contributor needs to build Social Harness,
check a change, and open a pull request. The
[development guide](docs/development/contributing.mdx) has the full
conventions.

## Where the authority lives

Contributions are judged against the public contracts in this repository:
[`docs/vision.md`](docs/vision.md) and the specifications under
[`docs/spec/`](docs/spec/). [`AGENTS.md`](AGENTS.md) and each package's
`AGENTS.md` add repository and package instructions.

Maintainers keep internal planning records and maintainer tooling outside this
repository. You do not need them to contribute; a change that alters a public
contract updates the matching page under `docs/spec/` in the same pull request.

### Maintainer records

Maintainers set `DOCS_INTERNAL_ROOT` to a checkout of the internal records at
the revision pinned in `.agents/internal-skills.json` and start with its
README. That revision pins the workflow; it does not approve proposed
decisions. The pinned skills under `.agents/skills/` and `.claude/skills/` are
updated and verified from that checkout, with `DOCS_COMMIT` set to the pinned
revision:

```shell
"$DOCS_INTERNAL_ROOT/bin/records" skills sync --target . --revision DOCS_COMMIT
"$DOCS_INTERNAL_ROOT/bin/records" skills check --target . --revision DOCS_COMMIT
```

## Prerequisites

*   Node.js at the version in [`.node-version`](.node-version).
*   pnpm at the version in the `packageManager` field of
    [`package.json`](package.json). With Corepack, `corepack enable` selects
    it.

## Set up a checkout

```shell
pnpm install
pnpm build
```

`bin/setup-worktree.sh` installs dependencies and builds every package in a
new `git worktree` checkout.

## Check a change

Run this sequence before opening a pull request:

```shell
pnpm build
pnpm test:affected
pnpm check
```

`pnpm check` runs `pnpm lint` and `pnpm format:check`; lint resolves types
against built output, so build first. The
[development guide](docs/development/contributing.mdx#before-submitting-a-pr)
lists the full pre-PR commands, including the documentation checks. CI runs
the full gate on every pull request.

## Add a changelog fragment

A user-visible change adds one fragment under `changelog.d/` instead of
editing `CHANGELOG.md`; CI rejects a pull request that edits `CHANGELOG.md`.
Name the fragment `<number>.<type>.md`, where `<number>` is the issue or pull
request it resolves, or `+<slug>.<type>.md` when there is none. `<type>` is
`added`, `changed`, `removed`, or `fixed`. The fragment is a single Markdown
paragraph. [`towncrier.toml`](towncrier.toml) holds the full rules.

## Open a pull request

*   Branch from `main` and open the pull request against `main`.
*   Keep one change per pull request, with its tests and documentation.
*   Describe what changed, why, and which checks you ran.
*   Link the issue the change resolves, if there is one.
*   A maintainer reviews every pull request before it merges.

To report a vulnerability, follow [`SECURITY.md`](SECURITY.md) instead of
opening a pull request or issue.
