/**
 * E2E echo integration test (spec A11).
 *
 * Pattern: `packages/openclaw-channel/src/__tests__/echo-server.test.ts` +
 * `vitest.integration.globalSetup.ts`. Agent SDK spike #182 (sbd#182) pattern
 * uses PGlite / npx-spawn server for a faster CI fixture; this test's
 * global-setup will follow that pattern (spawn `@moltzap/server` as a
 * subprocess — see adjacent `vitest.integration.globalSetup.ts` stub).
 *
 * What the integration test proves (once implemented):
 *   - `bootClaudeCodeChannel` returns Ok against a real MoltZap server.
 *   - A round-trip message from peer agent renders with contract-correct
 *     meta keys (`chat_id`, `message_id`, `user`, `ts`).
 *   - The MCP server's capability declaration matches spec A14.
 *   - Clean shutdown on `handle.stop` — no lingering sockets, no open fibers.
 *
 * Architect stage: skeleton only.
 */

import { describe, it } from "vitest";

describe("echo integration — @moltzap/claude-code-channel", () => {
  it.todo(
    "boot → peer sends 'ping' → notification emitted with contract meta keys",
  );
  it.todo("reply (no reply_to) routes to last-active chat");
  it.todo("reply (reply_to = known message_id) routes to that chat");
  it.todo("reply (reply_to unknown) returns tool error (isError: true)");
  it.todo("handle.stop closes WS and MCP transport cleanly");
});
