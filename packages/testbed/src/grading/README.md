# Grading boundary

Reading a sealed recording as evidence. This layer reads recordings and
never runs one.

- `grader.ts` — the published `@moltzap/testbed/grader` entry: the generic
  code-based grading surface over a sealed recording.
- `cc-judge-recording-harness.ts` — the harness module cc-judge loads to
  grade a recording.
- `cc-judge-bundle-plan.ts` — turns a bundle's `grade:` half into a
  cc-judge plan.

The two `cc-judge-*` modules ship as dist files a plan points at by path,
resolved as siblings of the `./grader` entry, rather than as export-map
entries. That is what keeps a consumer's name off the instrument's
published surface, and it is why the three files share one directory.
