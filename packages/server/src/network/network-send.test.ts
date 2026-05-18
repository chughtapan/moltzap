/**
 * Unit tests for {@link NetworkSendService}.
 *
 * Each test covers exactly one branch of the send path:
 *   - durable agent address (`tm:agent:&lt;agentId&gt;`): resolves through
 *     the resolver's forward map and writes to one of the agent's
 *     live connections (Phase 9 + plan §1.3 in-process loopback).
 *   - {@link RecipientNotResolved}: agent has no live connection;
 *     resolver hit + connection gone (race); app-TM with no registered
 *     handler.
 *   - app-TM dispatch via {@link AppTmRegistry}: registered handler runs
 *     in-process and returns DeliveryAck (Phase 9b round 3 R14).
 *   - {@link WriteFailed}: connection.write rejects.
 *
 * Phase 9b consumer-migration (sub-issue #460 amendment): the legacy
 * `agent-conn` `EndpointAddress` kind retired. The resolver now keys by
 * `ConnectionId` directly; the public `EndpointAddressKind` union is
 * `agent | app`. Tests that previously exercised `tm:agent-conn:&lt;connId&gt;`
 * routing have been folded into the durable `tm:agent:&lt;agentId&gt;` cases
 * (the `agent-conn` form was always internal to the resolver and never
 * appeared on the wire). Phase 9b round 3 R14: the `app` kind is now
 * implemented via {@link AppTmRegistry}; tests that previously asserted
 * `EndpointKindNotImplemented` now exercise the registered-handler /
 * unregistered-handler branches.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  endpointAddress,
  makeEndpointAddress,
} from "@moltzap/protocol/network";
import { agentId } from "@moltzap/protocol/testing";
import { ConnectionManager } from "../transport/connection.js";
import { unusedJsonRpcClient } from "../transport/connection.test-utils.js";
import {
  AgentEndpointResolver,
  connectionId,
} from "./agent-endpoint-resolver.js";
import { AppTmRegistry } from "./app-tm-registry.js";
import {
  DeliveryAck,
  NetworkSendService,
  RecipientNotResolved,
  WriteFailed,
  opaquePayload,
} from "./network-send.js";

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const CONN_A = connectionId("00000000-0000-4000-8000-00000000c001");

const APP_ADDR = endpointAddress(`tm:app:00000000-0000-4000-8000-0000000a9990`);
// Durable agent-id form `tm:agent:<agentId>` - what task-manager
// registration writes into `tasks.tm_endpoint_address`.
const ALICE_DURABLE = makeEndpointAddress("agent", ALICE);

const makeResolver = (): AgentEndpointResolver =>
  Effect.runSync(AgentEndpointResolver.make);

const makeRegistry = (): AppTmRegistry => Effect.runSync(AppTmRegistry.make);

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
  id: string,
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
    jsonRpcClient: unusedJsonRpcClient(),
  };
}

describe("NetworkSendService.send — durable delivery", () => {
  it("durable agent address (`tm:agent:<agentId>`): resolves through forward map, writes payload, returns DeliveryAck", () => {
    // Phase 9 / plan §2.4.a + §1.3: durable TM-routed sends use the
    // `tm:agent:<agentId>` form. The resolver maps the agent to its
    // live ConnectionIds; sendToDurableAgent picks one and writes
    // there. In-process loopback: the same code path always runs (no
    // short-circuit).
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const capture = { raw: null as string | null };
    const conn = fakeConnection(CONN_A, "ok", capture);
    connections.add(conn);

    Effect.runSync(resolver.add(ALICE, CONN_A));

    const service = new NetworkSendService(
      resolver,
      connections,
      makeRegistry(),
    );
    const payload = opaquePayload(`{"jsonrpc":"2.0","method":"x","params":{}}`);

    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeInstanceOf(DeliveryAck);
      expect(exit.value.to).toEqual(ALICE_DURABLE);
    }
    expect(capture.raw).toBe(payload);
  });
});

describe("NetworkSendService.send — durable failures", () => {
  it("durable agent address: agent has no live connection → RecipientNotResolved", () => {
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const service = new NetworkSendService(
      resolver,
      connections,
      makeRegistry(),
    );
    const payload = opaquePayload("{}");

    // ALICE_DURABLE references a registered TM that is not currently
    // connected. The durable address persists in the column, but no
    // socket holds it.
    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });

  it("durable agent address: resolver hit but connection gone → RecipientNotResolved", () => {
    // Race: resolver still holds the entry but the connection closed
    // between the WS finalizer and the send call.
    const resolver = makeResolver();
    const connections = new ConnectionManager(); // empty
    Effect.runSync(resolver.add(ALICE, CONN_A));
    const service = new NetworkSendService(
      resolver,
      connections,
      makeRegistry(),
    );
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });
});

describe("NetworkSendService.send — app dispatch", () => {
  it("app address with registered handler: handler runs in-process, DeliveryAck", () => {
    // Phase 9b consumer-migration (sub-issue #460 round 3 R14):
    // `tm:app:<id>` dispatches through the in-process AppTmRegistry.
    // The handler runs on the server's Effect runtime — no WebSocket
    // round-trip. Plan §1.3 in-process loopback policy.
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const registry = makeRegistry();
    const seen = { payload: null as string | null };
    const rememberPayload = (p: string) =>
      Effect.sync(() => {
        seen.payload = p;
      });
    Effect.runSync(registry.register(APP_ADDR, rememberPayload));
    const service = new NetworkSendService(resolver, connections, registry);
    const payload = opaquePayload(`{"jsonrpc":"2.0","method":"x","params":{}}`);

    const exit = Effect.runSyncExit(service.send(APP_ADDR, payload));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBeInstanceOf(DeliveryAck);
      expect(exit.value.to).toEqual(APP_ADDR);
    }
    expect(seen.payload).toBe(payload);
  });

  it("app address with no registered handler: RecipientNotResolved", () => {
    // Matches the agent-kind "no live connection" semantics: the
    // address is well-formed but no recipient is currently bound.
    const resolver = makeResolver();
    const connections = new ConnectionManager();
    const service = new NetworkSendService(
      resolver,
      connections,
      makeRegistry(),
    );
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(APP_ADDR, payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(RecipientNotResolved);
      }
    }
  });
});

describe("NetworkSendService.send — write failure", () => {
  it("durable agent address: socket write rejects → WriteFailed wraps the cause", () => {
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
    const service = new NetworkSendService(
      resolver,
      connections,
      makeRegistry(),
    );
    const payload = opaquePayload("{}");

    const exit = Effect.runSyncExit(service.send(ALICE_DURABLE, payload));
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
