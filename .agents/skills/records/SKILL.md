---
name: records
description: Discover or file internal ADRs, plans, worklogs and Git-backed artifacts; verify revision-specific decision approval and record provenance.
---

Use `DOCS_INTERNAL_ROOT/bin/records --help`. Read the checkout's
`program/reference/records.md` for commands and `program/reference/lifecycle.md`
when interpreting approval or changing a decision. These are relative to the
private docs checkout, not the code package's working directory.

Resolve a registered scope before writing. Proposals are not binding, copied
accepted headers do not approve branch edits, and offline receipt claims require
verification before being called accepted. Missing source events are gaps to
state, never rationale to reconstruct.

Preview worklogs with `--dry-run`; its bytes match the actual record. Filing writes
locally without committing or contacting gbrain. Commit exact paths, refresh the
catalog and validate before calling a record filed. Raw artifacts are loaded only
on demand and verified against their manifest; do not overwrite failed attempts.
