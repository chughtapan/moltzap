/**
 * Unit tests for the transport layer — pure decision table + layer shape.
 * Integration coverage of the direct-WS branch lives in the E2E fixture
 * (`tests/integration/cli-multi-agent.int.test.ts`).
 */
import { describe, it } from "vitest";

describe("decideTransport", () => {
  it.todo(
    "returns UseDirect{as-flag} when impersonateKey is set, regardless of daemon state",
  );
  it.todo(
    "returns UseDirect{env-fallback} when MOLTZAP_API_KEY env + daemonReachable=false",
  );
  it.todo("returns UseDirect{profile} when profileKey set and no --as");
  it.todo(
    "returns UseDaemon when neither as-flag nor env-fallback nor profile",
  );
  it.todo(
    "never returns UseDaemon when impersonateKey is set (Invariant §4.2)",
  );
});

describe("makeTransportLayer", () => {
  it.todo("direct branch does not read ~/.moltzap/service.sock");
  it.todo("direct branch does not mutate ~/.moltzap/config.json");
  it.todo(
    "daemon branch fails TransportConfigError when socketPath is missing",
  );
});
