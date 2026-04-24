/**
 * Unit tests for `moltzap apps <subcommand>` handlers. Mocks Transport via
 * `Effect.provideService(Transport, fakeTransport)`; asserts on (method,
 * params) tuples recorded by the fake.
 *
 * Test-coverage floor (spec sbd#177 §"Cross-cutting acceptance floors"):
 * at least one success path and one RPC-failure path per handler.
 */
import { describe, it } from "vitest";

describe("apps register", () => {
  it.todo("calls apps/register with the manifest body and prints appId");
  it.todo("surfaces TransportRpcError as non-zero exit with message on stderr");
  it.todo("rejects a missing manifest file with AppsInputError");
});

describe("apps create", () => {
  it.todo("calls apps/create with appId and repeated invitedAgentIds");
  it.todo("prints session.id to stdout on success");
  it.todo("exits non-zero on TransportRpcError");
});

describe("apps list", () => {
  it.todo("calls apps/listSessions with optional filters");
  it.todo("exhaustively handles status = 'waiting' | 'active' | 'closed'");
  it.todo("exits non-zero on TransportTimeoutError");
});

describe("apps get", () => {
  it.todo("calls apps/getSession and prints session as JSON");
  it.todo("exits non-zero on TransportRpcError");
});

describe("apps close", () => {
  it.todo("calls apps/closeSession and prints closed session id");
  it.todo("exits non-zero on TransportRpcError");
});

describe("apps attest-skill", () => {
  it.todo("calls apps/attestSkill with { challengeId, skillUrl, version }");
  it.todo("exits non-zero on TransportRpcError");
});
