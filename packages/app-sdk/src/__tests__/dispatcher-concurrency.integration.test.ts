/**
 * Integration: AppHost + TestClient with two competing handlers.
 *
 * Spec: moltzap#356 §8 (test plan, file 5).
 *
 * Boots a real server (`testcontainers` if needed by host project) +
 * AppHost wired via `@moltzap/app-sdk` + `MoltZapWsClient`. Registers
 * two handlers — `before_dispatch` and `before_message_delivery` —
 * whose interaction reproduces the arena#248 deadlock against a
 * pre-#356 build, and proves liveness against the partitioned
 * dispatcher.
 *
 * No mocks — full transport, full schema validation, real fibers.
 * Mirrors the existing `app-sdk/src/app.handlers.test.ts` style.
 */
import { describe, it } from "vitest";

describe("integration: AppHost + partitioned s2c dispatcher", () => {
  it.todo(
    "two competing handlers (before_dispatch + before_message_delivery) for the " +
      "same conversation: parked before_dispatch resumes after sibling " +
      "before_message_delivery completes — both replies ship to the server",
  );
  it.todo(
    "concurrent handlers across two different sessions complete independently " +
      "(slow handler in session A does not delay session B)",
  );
  it.todo(
    "WS disconnect mid-handler interrupts every per-partition fiber cleanly " +
      "(no leaked fibers reported by `Effect.runtime` diagnostics)",
  );
});
