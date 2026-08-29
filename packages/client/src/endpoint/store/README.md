# Endpoint store internals

This private folder owns the daemon's one SQLite replica. `index.ts` assembles
the capability; `database/` performs the fresh-state compatibility preflight,
initializes schema 2, reopens compatible stores, and closes SQLite.
`anchors.ts` owns foundations, proposal locks, and re-anchor transitions;
`records.ts` owns staged and certified history; `deliveries.ts` owns pending
Client delivery state; `dissemination.ts` owns certification obligations; and
`outbound.ts` owns exact Router envelopes and retry replacement.
`management.ts` owns recovery and volatile frozen history snapshots, while
`rows/` keeps exact row checks out of the transition owners. The stable private
facade remains `../store.ts`; none of these implementation modules crosses the
public Client barrel.
