# CLI boundary

`moltzap-testbed`: the verb tree that operates the simulator from a
terminal. This is the outermost layer of the package — nothing below it
knows a terminal exists.

- `main.ts` — the verb tree and the process entry the `moltzap-testbed`
  bin points at. It is not a curated facade, so it is not `index.ts`.
- `documents.ts` — loading spec and bundle documents off disk.
- `exit.ts` — the tag-to-exit-code mapping and the one-line outcome text,
  together so the machine-readable and human-readable accounts of one
  outcome cannot drift apart.
- `demo.ts` — the scripted fault-theater fixture the `demo` verb runs. Its
  two participants are `demo-asker` and `demo-responder` from
  `simulator/stub-scripts.ts`.

Imports run one way: `cli/` reads `grading/` and `simulator/`; neither
reads back.
