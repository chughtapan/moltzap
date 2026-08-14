# Endpoint store internals

This private folder owns the daemon's one SQLite replica. `index.ts` assembles
the capability; `database/` acquires, checks, migrates, and closes SQLite;
`anchors.ts` and `records.ts` own atomic protocol transitions;
`management.ts` owns recovery and volatile frozen history snapshots; and
`rows/` keeps exact row checks out of those transition owners. The stable
private facade remains `../store.ts`; none of these implementation modules
cross the public Client barrel.
