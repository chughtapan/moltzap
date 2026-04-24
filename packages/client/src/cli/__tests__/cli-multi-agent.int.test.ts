/**
 * End-to-end integration fixture. Spec acceptance §"End-to-end integration
 * fixture" + research sbd#182 verdict (subprocess `standalone.js` via
 * vitest `globalSetup`; PGlite in-memory; suite-level boot budget 12–15s).
 *
 * Suite shape:
 *   1. `globalSetup.ts` spawns `node packages/server/dist/standalone.js`
 *      with a random high port and an in-memory PGlite config. The suite
 *      blocks until `/healthz` 200s; fails fast if the 30s ceiling is hit.
 *   2. Tests in this file run against `MOLTZAP_SERVER_URL=http://localhost:$PORT`.
 *   3. `globalTeardown.ts` SIGTERMs the subprocess; exit 0 expected per spike.
 *
 * Per-test budget: no subprocess spawn inside `it(...)`; reset state via
 * `resetCoreTestDb()` from `@moltzap/server-core/test-utils` if tests
 * require cleanliness.
 */
import { describe, it } from "vitest";

describe("multi-agent CLI roster (--as + --profile)", () => {
  it.todo(
    "register alice via --profile; register bob via --profile --no-persist",
  );
  it.todo("--no-persist leaves ~/.moltzap/ untouched (fs diff)");
  it.todo("moltzap --as $KEY_A apps create --invite bob prints a session id");
  it.todo(
    "moltzap --as $KEY_B conversations list shows the new session conversation",
  );
  it.todo(
    "two concurrent --as $KEY_A and --as $KEY_B sends produce distinct senders",
  );
  it.todo("--as invocation does not start or touch the singleton daemon");
});
