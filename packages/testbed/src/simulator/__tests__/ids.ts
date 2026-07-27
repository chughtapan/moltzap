/**
 * @file Seeded identifiers for fixtures.
 *
 * Wire identities are UUID-shaped by schema, and tests have to predict
 * them before a run starts, so they are derived from a name rather than
 * drawn. One derivation, shared: a second spelling would let a fixture
 * and the run it drives disagree about the same message.
 *
 * It lives beside the fixtures rather than inside `support.ts` so a unit
 * test can take it without the hermetic launch graph.
 */

/** The UUID a name derives: same name, same id, every run. */
export function deterministicUuid(seedText: string): string {
  const hex = [...seedText]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
