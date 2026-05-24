/**
 * Unit tests for {@link NetworkSendService}.
 *
 * Each test covers exactly one branch of the send path:
 *   - durable agent: resolves through the resolver's forward map and
 *     writes to one of the agent's live connections.
 *   - {@link RecipientNotResolved}: agent has no live connection;
 *     resolver hit + connection gone (race).
 *   - {@link WriteFailed}: connection.write rejects.
 *
 * Issue #673 cutover: the address-brand dispatch retired.
 * `send` now takes `AgentId` directly; the in-process `AppTmRegistry`
 * (the prior `tm-app-uuid` routing) was deleted alongside the default-TM
 * machinery — app moderators receive observability via the registered
 * remote-app connection writes that `AppHost` owns.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import * as Socket from "@effect/platform/Socket";
import { agentId } from "@moltzap/protocol/testing";
import { ConnectionManager } from "../transport/connection.js";
import { unusedOriginator } from "../transport/connection.test-utils.js";
import {
  AgentEndpointResolver,
  connectionId,
} from "./agent-endpoint-resolver.js";
import {
  DeliveryAck,
  NetworkSendService,
  RecipientNotResolved,
  WriteFailed,
  opaquePayload,
} from "./network-send.js";

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const CONN_A = connectionId("00000000-0000-4000-8000-00000000c001");

const makeResolver = (): AgentEndpointResolver =>
  Effect.runSync(AgentEndpointResolver.make);

/**
 * Build a minimal MoltZapConnection record that satisfies the parts of
 * the interface the send path actually reads:
 *   - `id`
 *   - `write(raw)`: Effect succeeding or failing per `writeBehavior`
 *
 * Other fields are present as placeholders to satisfy the structural type
 * but are not exercised by the send path.
 */
function fakeConnection(
  id: import("@moltzap/protocol/network").ConnectionId,
  writeBehavior: "ok" | { fail: Socket.SocketError },
  capture: { raw: string | null },
): import("../transport/connection.js").MoltZapConnection {
  return {
    id,
    write: (raw: string) => {
      capture.raw = raw;
      if (writeBehavior === "ok") return Effect.void;
      return Effect.fail(writeBehavior.fail);
    },
    shutdown: Effect.void,
    auth: null,
    lastPong: 0,
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    originator: unusedOriginator(),
  };
}

describe("NetworkSendService.send — durable delivery", () => {
  it("durable agent: resolves through forward map, writes payload, returns DeliveryAck", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const capture = { raw: null as string | null };
    const conn = fakeConnection(CONN_A, "ok", capture);
    connections.add(conn);

    Effect.runSync(resolver.add(ALICE, CONN_A));

    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload(`{"jsonrpc":"2.0","method":"x","params":{}}`);

    const exit = Effect.runSyncExit(service.send(ALICE, payload));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeInstanceOf(DeliveryAck);
      expect(exit.value.to).toEqual(ALICE);
    }
    expect(capture.raw).toBe(payload);
  });
});

describe("NetworkSendService.send — durable failures", () => {
  it("durable agent: agent has no live connection → RecipientNotResolved", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(ALICE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });

  it("durable agent: resolver hit but connection gone → RecipientNotResolved", () => {
    // Race: resolver still holds the entry but the connection closed
    // between the WS finalizer and the send call.
    const resolver = makeResolver();
    const connections = new ConnectionManager(); // empty
    Effect.runSync(resolver.add(ALICE, CONN_A));
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(ALICE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });
});

describe("NetworkSendService.send — write failure", () => {
  it("durable agent: socket write rejects → WriteFailed wraps the cause", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const capture = { raw: null as string | null };
    // Build a SocketError. The constructor accepts `reason`-style payloads;
    // any well-formed instance suffices here because the test inspects
    // identity via `instanceof`.
    const cause = new Socket.SocketGenericError({
      reason: "Write",
      cause: new Error("EPIPE"),
    });
    const conn = fakeConnection(CONN_A, { fail: cause }, capture);
    connections.add(conn);
    Effect.runSync(resolver.add(ALICE, CONN_A));
    const service = new NetworkSendService(resolver, connections);
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(ALICE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(WriteFailed);
        expect((failure.value as WriteFailed).cause).toBe(cause);
      }
    }
  });
});

describe("opaquePayload", () => {
  it("brands a string and round-trips bytes unchanged", () => {
    const raw = `{"jsonrpc":"2.0","method":"task/ready","params":{}}`;
    const branded = opaquePayload(raw);
    expect(String(branded)).toBe(raw);
  });
});
