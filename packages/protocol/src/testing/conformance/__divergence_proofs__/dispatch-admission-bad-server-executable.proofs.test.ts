/**
 * Known-bad-server divergence proofs for the 15 dispatch-admission
 * conformance registrars carved into `app/dispatch-*.ts` /
 * `app/dispatches-*.ts` / `app/same-conv-*.ts` /
 * `app/slow-first-*.ts` / `app/release-for-one-*.ts`.
 *
 * Each proof spins up a deliberately-misbehaving WebSocket server that
 * violates ONE named invariant of one registrar, drives a single
 * property run via `runExpectingFailure`, and asserts the failure tag.
 *
 * Mirrors the shape of `server-executable.proofs.test.ts`, but with a
 * heavier server-side state machine: the dispatch admission flow needs
 * cross-connection coordination (recipient → moderator round-trip via
 * S→C `dispatch/authorize`, then S→recipient `dispatch/release`), plus
 * a per-lease state machine the property bodies poll via
 * `dispatches/get`. The harness keeps that state in a single
 * `Ref<ServerState>` shared across every connection on a server
 * instance; per-connection writers register on connect and unregister
 * on close.
 *
 * Bad-server behaviors (one per registrar) are encoded as a
 * `BadServerBehavior` discriminated union; the inbound-frame handler
 * picks the misbehavior at the inflection point — wire ack vs.
 * synthesized release vs. consumed-emit vs. dispatches/get response —
 * so each property body's named assertion path triggers without the
 * bad server having to emulate the whole real-server surface.
 *
 * Issue #535. Architect plan (#533) §6 deletion-only meant no
 * replacement bad-server proofs landed in #534; this file restores the
 * gate's coverage of the dispatch-admission row.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "vitest";
import { Effect, Ref, Scope, Fiber, Duration } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import type {
  RequestFrame,
  ResponseFrame,
  NotificationFrame,
} from "../../../transport/wire.js";
import { JSON_RPC_RESERVED_CODES } from "../../../transport/wire-errors.js";
import { responseFrame } from "../../../transport/wire.js";
import {
  decodeFrame,
  encodeFrame,
  isRequestFrame,
  isResponseFrame,
} from "../_shared/frame-mutator.js";
import type {
  ConformanceArtifact,
  ConformanceRunContext,
  RealServerHandle,
} from "../_shared/runner.js";
import {
  collectProperties,
  type PropertyFailure,
} from "../_shared/registry.js";
import {
  registerDispatchRequestAckMintsLease,
  registerDispatchRequestRecipientDisconnectAbandons,
  registerDispatchAuthorizeVerdictResolves,
  registerDispatchAuthorizeTimeoutSynthesizesDeny,
  registerDispatchReleaseFiresAfterResolve,
  registerDispatchReleaseSkippedOnAbandoned,
  registerDispatchesConsumedFiresOnFirstSend,
  registerDispatchesConsumedSuppressedOnSecondSend,
  registerDispatchesExpiredFiresOnTtl,
  registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchesGetModeratorSeesRecord,
  registerDispatchesGetNonModeratorRejected,
  registerSameConversationDispatchesConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
} from "../app/index.js";
import { Connect } from "../../../network/methods.js";
import { AppsRegister } from "../../../app/methods.js";
import {
  expectInvariant,
  runExpectingFailure,
} from "./executable-proof-helpers.js";

// ── Bad-server behaviors ─────────────────────────────────────────────
//
// One discriminated tag per registrar. Each tag drives a single
// inflection-point misbehavior in the bad server's frame handler.

type BadServerBehavior =
  | "ack-non-uuidv4-leaseid"
  | "no-abandon-on-disconnect"
  | "release-decision-mismatch"
  | "synthesize-grant-on-timeout"
  | "release-fires-twice"
  | "consumed-leaseid-mismatch"
  | "consumed-fires-on-second-send"
  | "expired-leaseid-mismatch"
  | "expired-fires-after-consume"
  | "getlease-leaseid-mismatch"
  | "getlease-allow-non-moderator"
  | "lease-id-collision"
  | "serialize-second-ack"
  | "release-out-of-order";

const FORBIDDEN_ERROR_CODE = -32001;
// Lease TTL the bad server uses by default when grant carries no
// explicit `leaseTimeoutMs`. Long enough that proofs that don't care
// about TTL never see EXPIRED races.
const DEFAULT_LEASE_TIMEOUT_MS = 5_000;

// Raw wire-frame literals emitted by the bad server. Distinct from
// `RequestFrame` / `NotificationFrame` because the bad server *intentionally*
// emits values that violate the strong wire schemas — non-UUIDv4 leaseIds,
// mismatched dispatchIds, etc. Going through the strong builders would
// either reject these (defeating the proof) or require `as` casts at every
// site (the bypass the file used to have). A structural literal type plus
// a JSON.stringify shim keeps the bad-server's wire shape explicit.
type RawWireRequestLiteral = {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

type RawWireNotificationLiteral = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
};

function encodeRawWireFrame(
  frame: RawWireRequestLiteral | RawWireNotificationLiteral,
): string {
  return JSON.stringify(frame);
}
// Ack delay applied under `serialize-second-ack`: the bad server
// withholds the second `dispatch/request` ack until the first
// moderator round-trip resolves. The hold itself comes from the test's
// `holdResponseFor` (5_000 ms in the SlowFirst property), which is
// well above the property's `FAST_ACK_THRESHOLD_MS = 1_000`.
const SERIALIZE_DELAY_MS = 2_000;

// ── Top-level vitest entries ─────────────────────────────────────────

describe("dispatch-admission known-bad-server divergence proofs", () => {
  it("registerDispatchRequestAckMintsLease fails when ack leaseId is not UUIDv4", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchRequestAckMintsLease,
      { behavior: "ack-non-uuidv4-leaseid" },
    );
    expectInvariant(failure, "dispatch-request-ack-mints-lease");
  }, 20_000);

  it("registerDispatchRequestRecipientDisconnectAbandons fails when server keeps lease PENDING after recipient disconnect", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchRequestRecipientDisconnectAbandons,
      { behavior: "no-abandon-on-disconnect" },
    );
    // Property body has no explicit `dispatchAdmissionViolation`; the
    // failure surfaces from the driver's `assertLeaseState(ABANDONED)`
    // poll exhausting its bound.
    expectInvariant(failure, "driver.assertLeaseState");
  }, 20_000);

  it("registerDispatchAuthorizeVerdictResolves fails when server emits release with mismatched decision", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchAuthorizeVerdictResolves,
      { behavior: "release-decision-mismatch" },
    );
    expectInvariant(failure, "dispatch-authorize-verdict-resolves-lease");
  }, 20_000);

  it("registerDispatchAuthorizeTimeoutSynthesizesDeny fails when synthesized release carries decision=grant", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchAuthorizeTimeoutSynthesizesDeny,
      { behavior: "synthesize-grant-on-timeout" },
    );
    expectInvariant(failure, "dispatch-authorize-timeout-synthesizes-deny");
  }, 20_000);

  it("registerDispatchReleaseFiresAfterResolve fails when server emits release twice for one lease", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchReleaseFiresAfterResolve,
      { behavior: "release-fires-twice" },
    );
    expectInvariant(failure, "dispatch-release-fires-after-resolve");
  }, 20_000);

  it("registerDispatchReleaseSkippedOnAbandoned fails when server keeps lease PENDING after recipient disconnect", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchReleaseSkippedOnAbandoned,
      { behavior: "no-abandon-on-disconnect" },
    );
    expectInvariant(failure, "driver.assertLeaseState");
  }, 20_000);

  it("registerDispatchesConsumedFiresOnFirstSend fails when dispatches/consumed reports a mismatched leaseId", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchesConsumedFiresOnFirstSend,
      { behavior: "consumed-leaseid-mismatch" },
    );
    expectInvariant(failure, "dispatches-consumed-fires-on-first-send");
  }, 20_000);

  it("registerDispatchesConsumedSuppressedOnSecondSend fails when dispatches/consumed fires again on the second send", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchesConsumedSuppressedOnSecondSend,
      { behavior: "consumed-fires-on-second-send" },
    );
    expectInvariant(failure, "dispatches-consumed-suppressed-on-second-send");
  }, 20_000);

  it("registerDispatchesExpiredFiresOnTtl fails when dispatches/expired reports a mismatched leaseId", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchesExpiredFiresOnTtl,
      { behavior: "expired-leaseid-mismatch" },
    );
    expectInvariant(failure, "dispatches-expired-fires-on-ttl");
  }, 20_000);

  it("registerDispatchesExpiredSuppressedOnConsumeBeforeTtl fails when dispatches/expired fires after CONSUMED", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
      { behavior: "expired-fires-after-consume" },
    );
    expectInvariant(
      failure,
      "dispatches-expired-suppressed-on-consume-before-ttl",
    );
  }, 20_000);

  it("registerDispatchesGetModeratorSeesRecord fails when dispatches/get returns a mismatched leaseId", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchesGetModeratorSeesRecord,
      { behavior: "getlease-leaseid-mismatch" },
    );
    expectInvariant(failure, "dispatches-get-moderator-sees-record");
  }, 20_000);

  it("registerDispatchesGetNonModeratorRejected fails when non-moderator dispatches/get returns the wrong error code", async () => {
    const failure = await runSingleDispatchProof(
      registerDispatchesGetNonModeratorRejected,
      { behavior: "getlease-allow-non-moderator" },
    );
    expectInvariant(failure, "dispatches-get-non-moderator-rejected");
  }, 20_000);

  it("registerSameConversationDispatchesConcurrent fails when concurrent leases collide on leaseId", async () => {
    const failure = await runSingleDispatchProof(
      registerSameConversationDispatchesConcurrent,
      { behavior: "lease-id-collision" },
    );
    expectInvariant(
      failure,
      "same-conversation-dispatches-reach-moderator-concurrently",
    );
  }, 30_000);

  it("registerSlowFirstDoesNotDelaySecondAck fails when server serializes acks behind the first moderator reply", async () => {
    const failure = await runSingleDispatchProof(
      registerSlowFirstDoesNotDelaySecondAck,
      { behavior: "serialize-second-ack" },
    );
    expectInvariant(
      failure,
      "slow-first-moderator-call-does-not-delay-second-ack",
    );
  }, 30_000);

  it("registerReleaseForOneLeaseDoesNotWaitOnAnother fails when server emits releases in mint-order (slow first blocks fast second)", async () => {
    const failure = await runSingleDispatchProof(
      registerReleaseForOneLeaseDoesNotWaitOnAnother,
      { behavior: "release-out-of-order" },
    );
    expectInvariant(failure, "recipient.waitForRelease");
  }, 30_000);
});

// ── Single-property runner ───────────────────────────────────────────

async function runSingleDispatchProof(
  register: (ctx: ConformanceRunContext) => void,
  opts: { readonly behavior: BadServerBehavior },
): Promise<PropertyFailure> {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* makeBadDispatchServerContext(opts.behavior);
        register(ctx);
        const properties = collectProperties(ctx);
        if (properties.length !== 1) {
          return yield* Effect.die(
            new Error(`expected one property, got ${properties.length}`),
          );
        }
        return yield* runExpectingFailure(properties[0]!);
      }),
    ),
  );
  if (exit._tag === "Failure") {
    throw new Error(`proof harness defect: ${exit.cause.toString()}`);
  }
  return exit.value;
}

function makeBadDispatchServerContext(
  behavior: BadServerBehavior,
): Effect.Effect<ConformanceRunContext, never, Scope.Scope> {
  return Effect.gen(function* () {
    const httpHandle = yield* makeRegistrationHttpServer;
    const wsHandle = yield* makeBadDispatchWebSocketServer(behavior);
    const artifacts = yield* Ref.make<ReadonlyArray<ConformanceArtifact>>([]);
    const realServer: RealServerHandle = {
      baseUrl: httpHandle.baseUrl,
      wsUrl: wsHandle.wsUrl,
      close: Effect.void,
    };
    return {
      realServer,
      toxiproxy: null,
      opts: {
        tiers: ["A", "B", "C", "E"],
        realServer: Effect.succeed(realServer),
        numRuns: 1,
      },
      seed: 42,
      artifacts,
    } satisfies ConformanceRunContext;
  });
}

// ── HTTP register (verbatim shape from server-executable.proofs) ─────

const BAD_SERVER_AGENT_UUID_PREFIX = "00000000-0000-4000-8000-";
const BAD_SERVER_AGENT_UUID_NODE_LEN = 12;

function badServerAgentId(counter: number): string {
  return `${BAD_SERVER_AGENT_UUID_PREFIX}${counter
    .toString(16)
    .padStart(BAD_SERVER_AGENT_UUID_NODE_LEN, "0")}`;
}

const makeRegistrationHttpServer: Effect.Effect<
  { readonly baseUrl: string },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  // Each registration mints a new (agentId, apiKey) pair derived from a
  // monotonically-increasing counter. The bad WS server's Connect
  // handler reverses the apiKey suffix to recover the agentId, keeping
  // the HTTP and WS sides loosely coupled — no shared registry needed.
  let counter = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/auth/register") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    req.resume();
    req.on("end", () => {
      counter += 1;
      const agentId = badServerAgentId(counter);
      const apiKey = `bad-server-key-${counter}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          agentId,
          apiKey,
          claimUrl: `http://127.0.0.1/claim/${counter}`,
          claimToken: `claim-${counter}`,
        }),
      );
    });
  });

  const listening = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<http.Server>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(server);
          });
        }),
      catch: (cause) => cause,
    }).pipe(Effect.orDie),
    (active) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            active.close(() => resolve());
          }),
      ).pipe(Effect.orDie),
  );
  const address = listening.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
});

// ── Bad-dispatch WS server ───────────────────────────────────────────

interface LeaseRecord {
  readonly dispatchId: string;
  readonly leaseId: string;
  readonly recipientConnId: number;
  readonly recipientAgentId: string;
  readonly conversationId: string;
  // Per-recipient mint order. Drives release emission ordering under
  // `release-out-of-order` (where we honor mint order even though the
  // moderator reply arrival order differs).
  readonly mintIndex: number;
  state:
    | "PENDING"
    | "CLAIMED"
    | "GRANTED"
    | "CONSUMED"
    | "DENIED"
    | "EXPIRED"
    | "ABANDONED"
    | "HOLD";
  verdict:
    | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
    | { readonly _tag: "deny"; readonly reason?: string }
    | { readonly _tag: "hold"; readonly reason?: string }
    | null;
  consumedMessageId: string | null;
  leaseTimeoutMs: number | null;
  expiryFiber: Fiber.RuntimeFiber<unknown, unknown> | null;
}

interface ServerState {
  readonly agentByConn: Map<number, string>;
  readonly writers: Map<number, (raw: string) => Effect.Effect<void, unknown>>;
  moderatorAgentId: string | null;
  moderatorConnId: number | null;
  // Server-side moderator-response TTL (ms). Mirrors the manifest's
  // `hooks.dispatch_authorize.timeout_ms` captured at apps/register.
  // Properties that exercise the synthesized-deny path pass a small
  // value (200 ms); others pass 5-30 s.
  moderatorResponseTimeoutMs: number;
  readonly leases: Map<string /* dispatchId */, LeaseRecord>;
  readonly fixedTaskId: string;
  readonly fixedConversationId: string;
}

function makeBadDispatchWebSocketServer(
  behavior: BadServerBehavior,
): Effect.Effect<{ readonly wsUrl: string }, never, Scope.Scope> {
  return Effect.gen(function* () {
    const stateRef = yield* Ref.make<ServerState>({
      agentByConn: new Map(),
      writers: new Map(),
      moderatorAgentId: null,
      moderatorConnId: null,
      moderatorResponseTimeoutMs: 5_000,
      leases: new Map(),
      fixedTaskId: "00000000-0000-4000-8000-000000000a01",
      fixedConversationId: "00000000-0000-4000-8000-000000000c01",
    });
    const connCounter = yield* Ref.make(0);
    // Per-server in-flight S→C `dispatch/authorize` correlator. Keyed
    // by request id; each entry is a callback the recipient-side fiber
    // installs before sending the request and resolves when the
    // moderator's reply lands on its connection.
    const authorizeWaiters = yield* Ref.make<
      Map<
        string,
        (
          response:
            | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
            | { readonly _tag: "error"; readonly reason: string }
            | { readonly _tag: "closed" },
        ) => void
      >
    >(new Map());
    // Fixed `lease-id-collision` shared id so both concurrent dispatches
    // collide deterministically.
    const collisionLeaseIdRef = yield* Ref.make<string | null>(null);
    // Per-recipient mint counter — drives `LeaseRecord.mintIndex` so
    // release emission can re-serialize on mint order under the
    // `release-out-of-order` behavior.
    const mintCounterByRecipient = yield* Ref.make<Map<number, number>>(
      new Map(),
    );
    // Per-recipient: index of the next-mint to emit. Releases for
    // higher mint indices block until lower indices have emitted.
    const nextEmitIndexByRecipient = yield* Ref.make<Map<number, number>>(
      new Map(),
    );
    // Whether the server has already received its first
    // `dispatch/request` for this server instance. Drives the
    // `serialize-second-ack` failure mode: the second request's ack is
    // delayed for `SERIALIZE_DELAY_MS` so the property's wall-clock
    // check on the second ack's latency trips.
    const firstAckHeldRef = yield* Ref.make<boolean>(false);

    const server = yield* NodeSocketServer.makeWebSocket({
      port: 0,
      host: "127.0.0.1",
    }).pipe(Effect.orDie);

    yield* Effect.forkScoped(
      server
        .run((socket) =>
          Effect.gen(function* () {
            const connId = yield* Ref.updateAndGet(connCounter, (n) => n + 1);
            const writer = yield* socket.writer;
            const writeEffect = (raw: string) => writer(raw).pipe(Effect.orDie);
            yield* Ref.update(stateRef, (s) => {
              s.writers.set(connId, writeEffect);
              return s;
            });

            yield* socket
              .runRaw((data) => {
                const raw =
                  typeof data === "string"
                    ? data
                    : new TextDecoder("utf-8").decode(data);
                return handleInboundFrame({
                  raw,
                  connId,
                  stateRef,
                  authorizeWaiters,
                  collisionLeaseIdRef,
                  firstAckHeldRef,
                  mintCounterByRecipient,
                  nextEmitIndexByRecipient,
                  behavior,
                });
              })
              .pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    yield* onConnectionClose({
                      connId,
                      stateRef,
                      authorizeWaiters,
                      behavior,
                    });
                  }),
                ),
                Effect.ignore,
              );
          }).pipe(Effect.ignore),
        )
        .pipe(Effect.ignore),
    );

    const address = server.address;
    if (address._tag !== "TcpAddress") {
      return yield* Effect.die(
        new Error(`expected TcpAddress, got ${address._tag}`),
      );
    }
    return { wsUrl: `ws://${address.hostname}:${address.port}` };
  });
}

// ── Frame plumbing ───────────────────────────────────────────────────

type ModeratorVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
  | { readonly _tag: "deny"; readonly reason?: string }
  | { readonly _tag: "hold"; readonly reason?: string };

interface HandleInboundFrameOpts {
  readonly raw: string;
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
  readonly authorizeWaiters: Ref.Ref<
    Map<
      string,
      (
        response:
          | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
          | { readonly _tag: "error"; readonly reason: string }
          | { readonly _tag: "closed" },
      ) => void
    >
  >;
  readonly collisionLeaseIdRef: Ref.Ref<string | null>;
  readonly firstAckHeldRef: Ref.Ref<boolean>;
  readonly mintCounterByRecipient: Ref.Ref<Map<number, number>>;
  readonly nextEmitIndexByRecipient: Ref.Ref<Map<number, number>>;
  readonly behavior: BadServerBehavior;
}

function handleInboundFrame(opts: HandleInboundFrameOpts): Effect.Effect<void> {
  return Effect.gen(function* () {
    const decoded = yield* Effect.either(decodeFrame(opts.raw, "inbound"));
    if (decoded._tag === "Left") return;
    const frame = decoded.right;
    if (isResponseFrame(frame)) {
      // Reply from the moderator to a server-issued `dispatch/authorize`.
      yield* handleAuthorizeResponse({
        frame,
        authorizeWaiters: opts.authorizeWaiters,
      });
      return;
    }
    if (!isRequestFrame(frame)) return;

    switch (frame.method) {
      case Connect.name: {
        yield* handleConnect({
          frame,
          connId: opts.connId,
          stateRef: opts.stateRef,
        });
        return;
      }
      case AppsRegister.name: {
        yield* handleAppsRegister({
          frame,
          connId: opts.connId,
          stateRef: opts.stateRef,
        });
        return;
      }
      case "tasks/create": {
        const stateForCaller = yield* Ref.get(opts.stateRef);
        const callerAgentId =
          stateForCaller.agentByConn.get(opts.connId) ??
          "00000000-0000-4000-8000-000000000001";
        yield* writeResponse(opts.stateRef, opts.connId, frame.id, {
          result: yield* makeTaskResult(opts.stateRef, callerAgentId),
        });
        return;
      }
      case "tasks/createConversation": {
        const stateForCaller = yield* Ref.get(opts.stateRef);
        const callerAgentId =
          stateForCaller.agentByConn.get(opts.connId) ??
          "00000000-0000-4000-8000-000000000001";
        yield* writeResponse(opts.stateRef, opts.connId, frame.id, {
          result: yield* makeConversationResult(opts.stateRef, callerAgentId),
        });
        return;
      }
      case "conversations/addParticipant": {
        const params = frame.params as {
          participant?: { id?: unknown };
        };
        const participantAgentId =
          typeof params.participant?.id === "string"
            ? params.participant.id
            : "00000000-0000-4000-8000-000000000003";
        yield* writeResponse(opts.stateRef, opts.connId, frame.id, {
          result: makeAddParticipantResult(participantAgentId),
        });
        return;
      }
      case "messages/send": {
        yield* handleMessagesSend({ frame, connId: opts.connId, opts });
        return;
      }
      case "dispatches/get": {
        yield* handleDispatchesGet({ frame, connId: opts.connId, opts });
        return;
      }
      case "dispatch/request": {
        yield* handleDispatchRequest({ frame, connId: opts.connId, opts });
        return;
      }
      default: {
        // Default: echo a permissive empty success — covers any
        // method the driver setup happens to call but the bad server
        // doesn't otherwise model.
        yield* writeResponse(opts.stateRef, opts.connId, frame.id, {
          result: {},
        });
      }
    }
  });
}

// ── Request-method handlers ──────────────────────────────────────────

function handleConnect(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as { agentKey?: unknown };
    const apiKey = typeof params.agentKey === "string" ? params.agentKey : null;
    if (apiKey !== null) {
      // Map `apiKey → agentId` per the HTTP register's known issuance.
      // Because the bad-dispatch tests run with a single HTTP server
      // shared across the WS, we synthesize a stable agentId from the
      // key suffix.
      const match = /bad-server-key-(\d+)/.exec(apiKey);
      if (match !== null) {
        const counter = Number(match[1]);
        const agentId = badServerAgentId(counter);
        yield* Ref.update(args.stateRef, (s) => {
          s.agentByConn.set(args.connId, agentId);
          return s;
        });
      }
    }
    yield* writeResponse(args.stateRef, args.connId, args.frame.id, {
      result: {},
    });
  });
}

function handleAppsRegister(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as {
      manifest?: {
        appId?: unknown;
        hooks?: { dispatch_authorize?: { timeout_ms?: unknown } };
      };
    };
    const appId =
      typeof params.manifest?.appId === "string"
        ? params.manifest.appId
        : "bad-server-app";
    const timeoutMsRaw = params.manifest?.hooks?.dispatch_authorize?.timeout_ms;
    const moderatorTimeoutMs =
      typeof timeoutMsRaw === "number" && timeoutMsRaw > 0
        ? timeoutMsRaw
        : 5_000;
    yield* Ref.update(args.stateRef, (s) => {
      // The most-recent connection to call `apps/register` is the
      // moderator. Properties that loop `withDriver` mint fresh
      // moderator connections per iteration; tracking only the first
      // would leave subsequent iterations' dispatches/get without a
      // recognized authority.
      const agentId = s.agentByConn.get(args.connId) ?? null;
      s.moderatorAgentId = agentId;
      s.moderatorConnId = args.connId;
      s.moderatorResponseTimeoutMs = moderatorTimeoutMs;
      return s;
    });
    yield* writeResponse(args.stateRef, args.connId, args.frame.id, {
      result: { appId },
    });
  });
}

function makeTaskResult(
  stateRef: Ref.Ref<ServerState>,
  callerAgentId: string,
): Effect.Effect<unknown> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return {
      task: {
        id: state.fixedTaskId,
        appId: "bad-server-app",
        initiatorAgentId: callerAgentId,
        status: "active",
        tmEndpointAddress: "ws://bad-server-tm",
        startedAt: null,
        endedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
  });
}

function makeConversationResult(
  stateRef: Ref.Ref<ServerState>,
  callerAgentId: string,
): Effect.Effect<unknown> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    return {
      conversation: {
        id: state.fixedConversationId,
        type: "group",
        name: "bad-server-conv",
        createdBy: callerAgentId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  });
}

function makeAddParticipantResult(participantAgentId: string): unknown {
  return {
    participant: {
      conversationId: "00000000-0000-4000-8000-000000000c01",
      participant: {
        type: "agent",
        id: participantAgentId,
      },
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function handleMessagesSend(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as {
      conversationId?: unknown;
      dispatchLeaseId?: unknown;
    };
    const leaseId =
      typeof params.dispatchLeaseId === "string"
        ? params.dispatchLeaseId
        : null;
    if (leaseId === null) {
      // No lease: succeed unconditionally with a fake message id.
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        result: {
          message: makeFakeMessage(
            typeof params.conversationId === "string"
              ? params.conversationId
              : "00000000-0000-4000-8000-000000000c01",
          ),
        },
      });
      return;
    }
    const lease = yield* findLeaseByLeaseId(args.opts.stateRef, leaseId);
    if (lease === null) {
      // Unknown lease — treat as LeaseInvalid.
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        error: {
          code: FORBIDDEN_ERROR_CODE,
          message: "lease invalid",
          data: { state: "PENDING" },
        },
      });
      return;
    }
    if (lease.state === "GRANTED") {
      const messageId = freshUuidV4();
      lease.state = "CONSUMED";
      lease.consumedMessageId = messageId;
      // Cancel the post-grant TTL — except under
      // `expired-fires-after-consume`, where the TTL fiber MUST be
      // allowed to fire so the property's
      // `dispatches/expired unexpectedly fired after CONSUMED`
      // assertion fires.
      if (
        lease.expiryFiber !== null &&
        args.opts.behavior !== "expired-fires-after-consume"
      ) {
        yield* Fiber.interrupt(lease.expiryFiber);
        lease.expiryFiber = null;
      }
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        result: {
          message: makeFakeMessage(lease.conversationId, messageId),
        },
      });
      // Fire `dispatches/consumed` to the moderator (unless behavior
      // hijacks the leaseId).
      yield* emitDispatchesConsumed({
        stateRef: args.opts.stateRef,
        lease,
        messageId,
        leaseIdOverride:
          args.opts.behavior === "consumed-leaseid-mismatch"
            ? freshUuidV4()
            : null,
      });
      return;
    }
    if (lease.state === "CONSUMED") {
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        error: {
          code: FORBIDDEN_ERROR_CODE,
          message: "lease invalid",
          data: { state: "CONSUMED" },
        },
      });
      // Under `consumed-fires-on-second-send`, the bad server emits a
      // second dispatches/consumed even though the lease is already
      // CONSUMED.
      if (args.opts.behavior === "consumed-fires-on-second-send") {
        yield* emitDispatchesConsumed({
          stateRef: args.opts.stateRef,
          lease,
          messageId: freshUuidV4(),
          leaseIdOverride: null,
        });
      }
      return;
    }
    if (lease.state === "EXPIRED") {
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        error: {
          code: FORBIDDEN_ERROR_CODE,
          message: "lease invalid",
          data: { state: "EXPIRED" },
        },
      });
      return;
    }
    // Anything else (DENIED, ABANDONED, HOLD, PENDING, CLAIMED) →
    // LeaseInvalid carrying current state.
    yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
      error: {
        code: FORBIDDEN_ERROR_CODE,
        message: "lease invalid",
        data: { state: lease.state },
      },
    });
  });
}

function handleDispatchesGet(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as { dispatchId?: unknown };
    const dispatchId =
      typeof params.dispatchId === "string" ? params.dispatchId : null;
    const state = yield* Ref.get(args.opts.stateRef);
    const isModerator = args.connId === state.moderatorConnId;
    if (!isModerator) {
      // Non-moderator caller. Default contract: Forbidden(-32001).
      // `getlease-allow-non-moderator` returns a different code (-32603)
      // so the property's `errorCode !== -32001` check fires.
      const code =
        args.opts.behavior === "getlease-allow-non-moderator"
          ? JSON_RPC_RESERVED_CODES.InternalError
          : FORBIDDEN_ERROR_CODE;
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        error: {
          code,
          message: "non-moderator dispatches/get rejected",
        },
      });
      return;
    }
    if (dispatchId === null) {
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        error: {
          code: JSON_RPC_RESERVED_CODES.InvalidParams,
          message: "dispatchId required",
        },
      });
      return;
    }
    const lease = state.leases.get(dispatchId);
    if (lease === undefined) {
      yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
        error: {
          code: JSON_RPC_RESERVED_CODES.InvalidParams,
          message: "lease not found",
        },
      });
      return;
    }
    // `getlease-leaseid-mismatch`: report a fresh-but-wrong leaseId so
    // the property body's `if (grantedView.leaseId !== ack.leaseId)`
    // check fires. assertLeaseState polls `state` only, so it still
    // settles correctly under this behavior.
    const reportedLeaseId =
      args.opts.behavior === "getlease-leaseid-mismatch"
        ? freshUuidV4()
        : lease.leaseId;
    yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
      result: {
        lease: makeLeaseRecordWire(lease, state, reportedLeaseId),
      },
    });
  });
}

function makeLeaseRecordWire(
  lease: LeaseRecord,
  state: ServerState,
  reportedLeaseId: string,
): unknown {
  const verdictWire = (() => {
    if (lease.verdict === null) return null;
    switch (lease.verdict._tag) {
      case "grant":
        return lease.verdict.leaseTimeoutMs !== undefined
          ? { decision: "grant", leaseTimeoutMs: lease.verdict.leaseTimeoutMs }
          : { decision: "grant" };
      case "deny":
        return lease.verdict.reason !== undefined
          ? { decision: "deny", reason: lease.verdict.reason }
          : { decision: "deny" };
      case "hold":
        return lease.verdict.reason !== undefined
          ? { decision: "hold", reason: lease.verdict.reason }
          : { decision: "hold" };
    }
  })();
  return {
    dispatchId: lease.dispatchId,
    leaseId: reportedLeaseId,
    conversationId: lease.conversationId,
    taskId: state.fixedTaskId,
    appId: "bad-server-app",
    recipientAgentId: lease.recipientAgentId,
    moderatorConnectionId: String(state.moderatorConnId ?? ""),
    tmEndpointAddress: "ws://bad-server-tm",
    state: lease.state,
    verdict: verdictWire,
    mintedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: lease.verdict !== null ? "2026-01-01T00:00:00.001Z" : null,
    consumedAt:
      lease.consumedMessageId !== null ? "2026-01-01T00:00:00.002Z" : null,
    consumedMessageId: lease.consumedMessageId,
    expiredAt: null,
    leaseTimeoutMs: lease.leaseTimeoutMs,
  };
}

function findLeaseByLeaseId(
  stateRef: Ref.Ref<ServerState>,
  leaseId: string,
): Effect.Effect<LeaseRecord | null> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    for (const lease of state.leases.values()) {
      if (lease.leaseId === leaseId) return lease;
    }
    return null;
  });
}

// ── dispatch/request orchestration ───────────────────────────────────

function handleDispatchRequest(args: {
  readonly frame: RequestFrame;
  readonly connId: number;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const params = args.frame.params as {
      conversationId?: unknown;
      messageId?: unknown;
      senderAgentId?: unknown;
    };
    const conversationId =
      typeof params.conversationId === "string"
        ? params.conversationId
        : "00000000-0000-4000-8000-000000000c01";
    // Mint the lease BEFORE any potential ack-serialization hold so
    // `lease-id-collision` and `serialize-second-ack` see a stable
    // record across orchestration paths.
    const dispatchId = freshUuidV4();
    const leaseId = yield* mintLeaseId(args.opts);
    const state = yield* Ref.get(args.opts.stateRef);
    const recipientAgentId = state.agentByConn.get(args.connId) ?? "";
    const mintIndex = yield* Ref.modify(
      args.opts.mintCounterByRecipient,
      (m) => {
        const next = (m.get(args.connId) ?? 0) + 1;
        m.set(args.connId, next);
        return [next - 1, m] as const;
      },
    );
    const lease: LeaseRecord = {
      dispatchId,
      leaseId,
      recipientConnId: args.connId,
      recipientAgentId,
      conversationId,
      mintIndex,
      state: "PENDING",
      verdict: null,
      consumedMessageId: null,
      leaseTimeoutMs: null,
      expiryFiber: null,
    };
    yield* Ref.update(args.opts.stateRef, (s) => {
      s.leases.set(dispatchId, lease);
      return s;
    });

    // `serialize-second-ack`: the FIRST ack lands immediately + holds
    // the serializer; the SECOND ack waits on it for a long time so
    // the property's wall-clock check trips.
    if (args.opts.behavior === "serialize-second-ack") {
      const isFirst = yield* Ref.modify(
        args.opts.firstAckHeldRef,
        (held) => [held, true] as const,
      );
      if (isFirst) {
        // Already a first-ack-held → second arrival. Block for
        // SERIALIZE_DELAY_MS before acking, so the wall-clock check in
        // the SlowFirst property fires.
        yield* Effect.sleep(Duration.millis(SERIALIZE_DELAY_MS));
      }
    }

    // The bad server's leaseId for ack purposes may differ from the
    // one we minted (under `ack-non-uuidv4-leaseid`).
    const ackLeaseId =
      args.opts.behavior === "ack-non-uuidv4-leaseid"
        ? "00000000-0000-1000-8000-000000000000"
        : leaseId;

    yield* writeResponse(args.opts.stateRef, args.connId, args.frame.id, {
      result: { leaseId: ackLeaseId, dispatchId },
    });

    // For the ack-non-uuidv4 behavior, the property body fails on the
    // ack check before any release; skip the moderator round-trip.
    if (args.opts.behavior === "ack-non-uuidv4-leaseid") {
      return;
    }

    // Fork the moderator round-trip + release emission so this RPC
    // returns immediately and the recipient can issue another request
    // concurrently.
    yield* Effect.forkDaemon(
      orchestrateAuthorize({ lease, opts: args.opts, params }).pipe(
        Effect.ignore,
      ),
    );
  });
}

function mintLeaseId(opts: HandleInboundFrameOpts): Effect.Effect<string> {
  return Effect.gen(function* () {
    if (opts.behavior === "lease-id-collision") {
      const existing = yield* Ref.get(opts.collisionLeaseIdRef);
      if (existing !== null) return existing;
      const fresh = freshUuidV4();
      yield* Ref.set(opts.collisionLeaseIdRef, fresh);
      return fresh;
    }
    return freshUuidV4();
  });
}

function orchestrateAuthorize(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
  readonly params: {
    readonly conversationId?: unknown;
    readonly messageId?: unknown;
    readonly senderAgentId?: unknown;
  };
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(args.opts.stateRef);
    if (state.moderatorConnId === null) {
      // No moderator — synthesize an immediate deny. (Should not happen
      // in practice; the driver always registers the app first.)
      yield* resolveLease({
        lease: args.lease,
        opts: args.opts,
        verdict: { _tag: "deny", reason: "no-moderator" },
      });
      return;
    }
    const moderatorWriter = state.writers.get(state.moderatorConnId);
    if (moderatorWriter === undefined) {
      yield* resolveLease({
        lease: args.lease,
        opts: args.opts,
        verdict: { _tag: "deny", reason: "moderator-disconnected" },
      });
      return;
    }

    const reqId = freshUuidV4();
    const verdictResult = yield* awaitModeratorReply({
      reqId,
      writer: moderatorWriter,
      authorizeWaiters: args.opts.authorizeWaiters,
      lease: args.lease,
      params: args.params,
      moderatorAgentId: state.moderatorAgentId ?? "",
      taskId: state.fixedTaskId,
      // Architect plan §3: server-side moderator-response TTL.
      // Honors the manifest's `hooks.dispatch_authorize.timeout_ms`
      // captured at apps/register so properties that exercise the
      // synthesized-deny path (TINY_MODERATOR_TIMEOUT_MS = 200 ms)
      // cause synthesis to fire before the property's
      // `waitForRelease` window elapses.
      timeoutMs: state.moderatorResponseTimeoutMs,
    });

    // Resolve verdict per behavior.
    let verdict: ModeratorVerdict;
    if (verdictResult._tag === "ok") {
      verdict = verdictResult.value;
    } else {
      // Moderator silent / errored → synthesize fail-closed deny by
      // default; under `synthesize-grant-on-timeout` synthesize grant
      // (the property checks for deny, so grant fails the body
      // assertion).
      verdict =
        args.opts.behavior === "synthesize-grant-on-timeout"
          ? { _tag: "grant" }
          : { _tag: "deny", reason: "timeout" };
    }
    yield* resolveLease({ lease: args.lease, opts: args.opts, verdict });
  });
}

function awaitModeratorReply(args: {
  readonly reqId: string;
  readonly writer: (raw: string) => Effect.Effect<void, unknown>;
  readonly authorizeWaiters: Ref.Ref<
    Map<
      string,
      (
        response:
          | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
          | { readonly _tag: "error"; readonly reason: string }
          | { readonly _tag: "closed" },
      ) => void
    >
  >;
  readonly lease: LeaseRecord;
  readonly params: {
    readonly messageId?: unknown;
    readonly senderAgentId?: unknown;
  };
  readonly moderatorAgentId: string;
  readonly taskId: string;
  readonly timeoutMs: number;
}): Effect.Effect<
  | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
  | { readonly _tag: "error"; readonly reason: string }
  | { readonly _tag: "closed" }
  | { readonly _tag: "timeout" }
> {
  return Effect.gen(function* () {
    const messageId =
      typeof args.params.messageId === "string"
        ? args.params.messageId
        : freshUuidV4();
    const senderAgentId =
      typeof args.params.senderAgentId === "string"
        ? args.params.senderAgentId
        : args.moderatorAgentId;
    const requestRaw = encodeRawWireFrame({
      jsonrpc: "2.0",
      id: args.reqId,
      method: "dispatch/authorize",
      params: {
        taskId: args.taskId,
        appId: "bad-server-app",
        conversationId: args.lease.conversationId,
        recipient: {
          agentId: args.lease.recipientAgentId,
          ownerId: "bad-server-owner",
        },
        message: {
          id: messageId,
          senderAgentId,
        },
        attempt: 0,
      },
    });
    // Promise-style waiter: install before send so the moderator's
    // reply (if it lands instantly) doesn't race the install.
    const promise = new Promise<
      | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
      | { readonly _tag: "error"; readonly reason: string }
      | { readonly _tag: "closed" }
    >((resolve) => {
      Effect.runSync(
        Ref.update(args.authorizeWaiters, (m) => {
          m.set(args.reqId, resolve);
          return m;
        }),
      );
    });
    yield* args.writer(requestRaw).pipe(Effect.orDie);
    const result = yield* Effect.tryPromise({
      try: () => promise,
      catch: (err) => err,
    }).pipe(
      Effect.timeoutTo({
        duration: Duration.millis(args.timeoutMs),
        onTimeout: () => ({ _tag: "timeout" }) as const,
        onSuccess: (v) =>
          v as
            | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
            | { readonly _tag: "error"; readonly reason: string }
            | { readonly _tag: "closed" },
      }),
      Effect.catchAll(() =>
        Effect.succeed({ _tag: "error" as const, reason: "transport" }),
      ),
      Effect.ensuring(
        Ref.update(args.authorizeWaiters, (m) => {
          m.delete(args.reqId);
          return m;
        }),
      ),
    );
    return result;
  });
}

function handleAuthorizeResponse(args: {
  readonly frame: ResponseFrame;
  readonly authorizeWaiters: Ref.Ref<
    Map<
      string,
      (
        response:
          | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
          | { readonly _tag: "error"; readonly reason: string }
          | { readonly _tag: "closed" },
      ) => void
    >
  >;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const id = args.frame.id;
    if (typeof id !== "string") return;
    const waiters = yield* Ref.get(args.authorizeWaiters);
    const resolve = waiters.get(id);
    if (resolve === undefined) return;
    if ("error" in args.frame) {
      resolve({ _tag: "error", reason: String(args.frame.error.code) });
      return;
    }
    const result = args.frame.result as {
      admission?: {
        decision?: unknown;
        leaseTimeoutMs?: unknown;
        reason?: unknown;
      };
    } | null;
    const verdict = parseVerdictFromAdmission(result?.admission);
    if (verdict === null) {
      resolve({ _tag: "error", reason: "unparseable-admission" });
      return;
    }
    resolve({ _tag: "ok", value: verdict });
  });
}

function parseVerdictFromAdmission(
  admission:
    | {
        readonly decision?: unknown;
        readonly leaseTimeoutMs?: unknown;
        readonly reason?: unknown;
      }
    | undefined,
): ModeratorVerdict | null {
  if (admission === undefined) return null;
  if (admission.decision === "grant") {
    return typeof admission.leaseTimeoutMs === "number"
      ? { _tag: "grant", leaseTimeoutMs: admission.leaseTimeoutMs }
      : { _tag: "grant" };
  }
  if (admission.decision === "deny") {
    return typeof admission.reason === "string"
      ? { _tag: "deny", reason: admission.reason }
      : { _tag: "deny" };
  }
  if (admission.decision === "hold") {
    return typeof admission.reason === "string"
      ? { _tag: "hold", reason: admission.reason }
      : { _tag: "hold" };
  }
  return null;
}

// ── Resolution: state transition + release emission ──────────────────

function resolveLease(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
  readonly verdict: ModeratorVerdict;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    args.lease.verdict = args.verdict;
    switch (args.verdict._tag) {
      case "grant":
        args.lease.state = "GRANTED";
        args.lease.leaseTimeoutMs =
          args.verdict.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
        break;
      case "deny":
        args.lease.state = "DENIED";
        break;
      case "hold":
        args.lease.state = "HOLD";
        break;
    }

    // Build the release verdict the bad server emits. Behaviors that
    // distort the verdict's decision do so on the wire only — the
    // server-side state machine still reflects the moderator's reply
    // so subsequent dispatches/get / messages/send queries report
    // realistic state.
    const wireVerdict = pickWireVerdict({
      verdict: args.verdict,
      behavior: args.opts.behavior,
    });

    // Under `release-out-of-order` honor mint order: a lease's release
    // emits only after every earlier-minted lease for the same
    // recipient has emitted. Slow first lease blocks fast second.
    if (args.opts.behavior === "release-out-of-order") {
      yield* awaitEarlierMintsEmitted(args.opts, args.lease);
    }
    yield* emitReleaseFrame({
      stateRef: args.opts.stateRef,
      recipientConnId: args.lease.recipientConnId,
      dispatchId: args.lease.dispatchId,
      leaseId: args.lease.leaseId,
      verdict: wireVerdict,
      leaseTimeoutMs:
        args.verdict._tag === "grant" ? args.lease.leaseTimeoutMs : null,
    });
    // Mark this mint as emitted so any waiting later-minted lease can
    // proceed.
    yield* Ref.update(args.opts.nextEmitIndexByRecipient, (m) => {
      const cur = m.get(args.lease.recipientConnId) ?? 0;
      m.set(
        args.lease.recipientConnId,
        Math.max(cur, args.lease.mintIndex + 1),
      );
      return m;
    });
    // Release-fires-twice: emit a duplicate release within the
    // property's `NO_SECOND_RELEASE_WINDOW_MS` (250 ms) tight window.
    if (args.opts.behavior === "release-fires-twice") {
      yield* Effect.sleep(Duration.millis(50));
      yield* emitReleaseFrame({
        stateRef: args.opts.stateRef,
        recipientConnId: args.lease.recipientConnId,
        dispatchId: args.lease.dispatchId,
        leaseId: args.lease.leaseId,
        verdict: wireVerdict,
        leaseTimeoutMs:
          args.verdict._tag === "grant" ? args.lease.leaseTimeoutMs : null,
      });
    }

    // Schedule the post-grant TTL fire for `dispatches/expired` (and
    // potentially `expired-fires-after-consume`).
    if (args.verdict._tag === "grant") {
      const ttl = args.lease.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
      const expiredFiber = yield* Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(ttl));
          // If consumed before TTL, only fire under
          // `expired-fires-after-consume`; default contract is to skip.
          if (
            args.lease.state === "CONSUMED" &&
            args.opts.behavior !== "expired-fires-after-consume"
          ) {
            return;
          }
          if (args.lease.state === "ABANDONED") return;
          if (args.lease.state !== "CONSUMED") {
            args.lease.state = "EXPIRED";
          }
          yield* emitDispatchesExpired({
            stateRef: args.opts.stateRef,
            lease: args.lease,
            leaseIdOverride:
              args.opts.behavior === "expired-leaseid-mismatch"
                ? freshUuidV4()
                : null,
          });
        }),
      );
      args.lease.expiryFiber = expiredFiber;
    }
  });
}

function awaitEarlierMintsEmitted(
  opts: HandleInboundFrameOpts,
  lease: LeaseRecord,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const ready = yield* Ref.modify(opts.nextEmitIndexByRecipient, (m) => {
        const cur = m.get(lease.recipientConnId) ?? 0;
        return [cur >= lease.mintIndex, m] as const;
      });
      if (ready) return;
      yield* Effect.sleep(Duration.millis(25));
    }
  });
}

function pickWireVerdict(args: {
  readonly verdict: ModeratorVerdict;
  readonly behavior: BadServerBehavior;
}): ModeratorVerdict {
  if (args.behavior === "release-decision-mismatch") {
    // Flip the decision on the wire while the server-side state
    // remains correct. Property body's `release decision X != expected
    // Y` violation fires.
    switch (args.verdict._tag) {
      case "grant":
        return { _tag: "deny", reason: "synthetic-mismatch" };
      case "deny":
        return { _tag: "grant" };
      case "hold":
        return { _tag: "grant" };
    }
  }
  return args.verdict;
}

function emitReleaseFrame(args: {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly recipientConnId: number;
  readonly dispatchId: string;
  readonly leaseId: string;
  readonly verdict: ModeratorVerdict;
  readonly leaseTimeoutMs: number | null;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(args.stateRef);
    const writer = state.writers.get(args.recipientConnId);
    if (writer === undefined) return;
    const verdictWire = (() => {
      switch (args.verdict._tag) {
        case "grant":
          return args.leaseTimeoutMs !== null
            ? { decision: "grant", leaseTimeoutMs: args.leaseTimeoutMs }
            : { decision: "grant" };
        case "deny":
          return args.verdict.reason !== undefined
            ? { decision: "deny", reason: args.verdict.reason }
            : { decision: "deny" };
        case "hold":
          return args.verdict.reason !== undefined
            ? { decision: "hold", reason: args.verdict.reason }
            : { decision: "hold" };
      }
    })();
    const params: Record<string, unknown> = {
      dispatchId: args.dispatchId,
      leaseId: args.leaseId,
      verdict: verdictWire,
    };
    if (args.verdict._tag === "grant" && args.leaseTimeoutMs !== null) {
      params.leaseTimeoutMs = args.leaseTimeoutMs;
    }
    const raw = encodeRawWireFrame({
      jsonrpc: "2.0",
      method: "dispatch/release",
      params,
    });
    yield* writer(raw).pipe(Effect.orDie);
  });
}

function emitDispatchesConsumed(args: {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly lease: LeaseRecord;
  readonly messageId: string;
  readonly leaseIdOverride: string | null;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(args.stateRef);
    if (state.moderatorConnId === null) return;
    const writer = state.writers.get(state.moderatorConnId);
    if (writer === undefined) return;
    const raw = encodeRawWireFrame({
      jsonrpc: "2.0",
      method: "dispatches/consumed",
      params: {
        dispatchId: args.lease.dispatchId,
        leaseId: args.leaseIdOverride ?? args.lease.leaseId,
        conversationId: args.lease.conversationId,
        messageId: args.messageId,
        consumedAt: "2026-01-01T00:00:00.003Z",
      },
    });
    yield* writer(raw).pipe(Effect.orDie);
  });
}

function emitDispatchesExpired(args: {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly lease: LeaseRecord;
  readonly leaseIdOverride: string | null;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(args.stateRef);
    if (state.moderatorConnId === null) return;
    const writer = state.writers.get(state.moderatorConnId);
    if (writer === undefined) return;
    const raw = encodeRawWireFrame({
      jsonrpc: "2.0",
      method: "dispatches/expired",
      params: {
        dispatchId: args.lease.dispatchId,
        leaseId: args.leaseIdOverride ?? args.lease.leaseId,
        conversationId: args.lease.conversationId,
        expiredAt: "2026-01-01T00:00:00.004Z",
      },
    });
    yield* writer(raw).pipe(Effect.orDie);
  });
}

// ── Connection close ─────────────────────────────────────────────────

function onConnectionClose(args: {
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
  readonly authorizeWaiters: Ref.Ref<
    Map<
      string,
      (
        response:
          | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
          | { readonly _tag: "error"; readonly reason: string }
          | { readonly _tag: "closed" },
      ) => void
    >
  >;
  readonly behavior: BadServerBehavior;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Ref.update(args.stateRef, (s) => {
      s.writers.delete(args.connId);
      s.agentByConn.delete(args.connId);
      // Default real-server contract: PENDING leases owned by this
      // recipient transition to ABANDONED. `no-abandon-on-disconnect`
      // skips the transition so the property's
      // `assertLeaseState(ABANDONED)` poll exhausts.
      if (args.behavior !== "no-abandon-on-disconnect") {
        for (const lease of s.leases.values()) {
          if (
            lease.recipientConnId === args.connId &&
            lease.state === "PENDING"
          ) {
            lease.state = "ABANDONED";
          }
        }
      }
      // If the moderator dropped, every outstanding S→C waiter resolves
      // closed so the orchestrator can synthesize a deny.
      if (args.connId === s.moderatorConnId) {
        s.moderatorConnId = null;
      }
      return s;
    });
  });
}

// ── Misc plumbing ────────────────────────────────────────────────────

function makeFakeMessage(conversationId: string, messageId?: string): unknown {
  return {
    id: messageId ?? freshUuidV4(),
    conversationId,
    senderId: "00000000-0000-4000-8000-000000000003",
    parts: [{ type: "text", text: "bad-server-stub" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function writeResponse(
  stateRef: Ref.Ref<ServerState>,
  connId: number,
  id: ResponseFrame["id"],
  body:
    | { result: unknown }
    | { error: { code: number; message: string; data?: unknown } },
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const writer = state.writers.get(connId);
    if (writer === undefined) return;
    yield* writer(encodeFrame(responseFrame(id, body))).pipe(Effect.orDie);
  });
}

function freshUuidV4(): string {
  return globalThis.crypto.randomUUID();
}
