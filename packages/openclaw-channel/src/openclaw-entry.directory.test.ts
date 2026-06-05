import { live as it } from "@effect/vitest";
import {
  createFakeChannelService,
  testAgentId,
  type FakeChannelService,
} from "@moltzap/client/test-utils";
import type { ServiceRpcError } from "@moltzap/client";
import type { ChannelService } from "@moltzap/client/channel-base";
import {
  AgentsList,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import { Data, Effect } from "effect";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { createMoltzapChannelPlugin } from "./openclaw-entry.js";

class DirectoryTestError extends Data.TaggedError("DirectoryTestError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function listPeers() {
  return Effect.tryPromise({
    try: () =>
      plugin.directory.listPeers({ cfg: makeCfg(), accountId: ACCOUNT_ID }),
    catch: (cause) =>
      new DirectoryTestError({ message: "listPeers failed", cause }),
  });
}

// `agents/list` is bounded to a server-default page. The openclaw directory
// must page through `nextCursor` to enumerate EVERY peer — a user with more
// visible agents than one page must not silently lose the tail.
// These tests drive `plugin.directory.listPeers` against a fake
// `callDefinition` that paginates `agents/list`, and assert the full set is
// resolved.

const ACCOUNT_ID = "directory-test";
const ACCOUNT_AGENT_NAME = "owner-directory";
const SELF_AGENT_ID = testAgentId("550e8400-e29b-41d4-a716-446655440501");
const SERVER_PAGE_SIZE = 50;
const CONTACT_COUNT = 130;
const EXPECTED_PAGE_CALLS = Math.ceil(CONTACT_COUNT / SERVER_PAGE_SIZE);

interface PeerAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly status: "active";
}

let fixture: FakeChannelService;
let plugin: ReturnType<typeof createMoltzapChannelPlugin>;
let agentsCallCount: number;
// When set, the fake server returns a CONSTANT non-advancing nextCursor
// on every `agents/list` page — the byzantine case the drain's
// cursor-cycle guard must terminate on (rather than loop forever).
let byzantineConstantCursor: boolean;
const CONSTANT_CURSOR = Buffer.from("stuck", "utf8").toString("base64url");

function buildAgents(count: number): ReadonlyArray<PeerAgent> {
  const agents: PeerAgent[] = [];
  for (let i = 0; i < count; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    agents.push({
      id: testAgentId(id),
      name: `peer-${i}`,
      displayName: `Peer ${i}`,
      status: "active",
    });
  }
  return agents;
}

const ALL_AGENTS = buildAgents(CONTACT_COUNT);

// Server-faithful keyset paging over an opaque cursor: the cursor is the
// index of the first row of the NEXT page, base64url-encoded so the
// consumer treats it as opaque. nextCursor present iff a further page
// exists (Invariant 1).
function agentsPage(cursor: string): {
  readonly agents: ReadonlyArray<PeerAgent>;
  readonly nextCursor?: string;
} {
  const start = cursor === "" ? 0 : Number(decodeCursor(cursor));
  const slice = ALL_AGENTS.slice(start, start + SERVER_PAGE_SIZE);
  const nextStart = start + SERVER_PAGE_SIZE;
  const hasMore = nextStart < ALL_AGENTS.length;
  return hasMore
    ? { agents: slice, nextCursor: encodeCursor(nextStart) }
    : { agents: slice };
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

function directoryCallDefinition<D extends RpcDefinition<string, any, any>>(
  definition: D,
  params: ParamsOf<D>,
): Effect.Effect<ResultOf<D>, ServiceRpcError> {
  if (definition.name === AgentsList.name) {
    agentsCallCount++;
    if (byzantineConstantCursor) {
      // Always claims "more" with the same cursor — never advances.
      return Effect.succeed({
        agents: ALL_AGENTS.slice(0, SERVER_PAGE_SIZE),
        nextCursor: CONSTANT_CURSOR,
      } as ResultOf<D>);
    }
    const cursor = (params as { readonly cursor?: string }).cursor ?? "";
    return Effect.succeed(agentsPage(cursor) as ResultOf<D>);
  }
  return Effect.succeed({} as ResultOf<D>);
}

// Production `MoltZapService.sendRpc` is a PROTOTYPE method that reads
// `this.client` inside `Effect.suspend`. Passed as a bare reference its
// receiver is stripped, so the suspend thunk dies with a `this`-undefined
// TypeError that `catchAll` cannot absorb. The standalone
// `directoryCallDefinition` fixture never reads `this`, so it cannot catch a
// receiver-stripping regression. This service's `callDefinition` reads
// `this.live` inside the suspend thunk, mirroring `this.client`: the directory
// code MUST bind `callDefinition` to
// the service before handing it to its drain consumers (binding to the
// service restores `this`), or `listPeers` rejects instead of resolving.
type ReceiverDependentCallDefinition = <
  D extends RpcDefinition<string, any, any>,
>(
  definition: D,
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, ServiceRpcError>;

interface ReceiverDependentService extends ChannelService {
  readonly live: true;
  callDefinition: ReceiverDependentCallDefinition;
}

function makeReceiverDependentCallDefinition(): ReceiverDependentCallDefinition {
  return function callDefinition<D extends RpcDefinition<string, any, any>>(
    this: ReceiverDependentService | undefined,
    definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, ServiceRpcError> {
    return Effect.suspend(() => {
      // `this.live` throws synchronously when `this` is undefined (receiver
      // stripped), matching `MoltZapService.callDefinition` reading
      // `this.client`. The directory MUST bind `service.callDefinition` to the
      // service before forwarding it to the drain consumers, or this thunk dies
      // on `this`-undefined.
      if (!this?.live) {
        throw new TypeError("Cannot read properties of undefined");
      }
      return directoryCallDefinition(definition, params);
    });
  };
}

function startGatewayWithService(build: () => ChannelService): void {
  vi.clearAllMocks();
  agentsCallCount = 0;
  byzantineConstantCursor = false;
  fixture = createFakeChannelService({ ownAgentId: SELF_AGENT_ID });
  const service = build();
  plugin = createMoltzapChannelPlugin({ createService: () => service });
  plugin.gateway.startAccount({
    cfg: makeCfg(),
    accountId: ACCOUNT_ID,
    account: makeAccount(),
    abortSignal: new AbortController().signal,
    setStatus: vi.fn(),
  });
}

// `ChannelService` plus the optional `callDefinition` the openclaw directory
// reads (`OpenClawClientService.callDefinition`).
type ServiceWithCallDefinition = ChannelService & {
  readonly callDefinition: typeof directoryCallDefinition;
};

function startDirectoryGateway(): void {
  startGatewayWithService(
    () =>
      ({
        ...fixture.service,
        callDefinition: directoryCallDefinition,
      }) satisfies ServiceWithCallDefinition as ChannelService,
  );
}

beforeEach(startDirectoryGateway);
afterEach(() => vi.clearAllMocks());

function enumeratesEveryPeer() {
  return Effect.gen(function* () {
    const peers = yield* listPeers();
    // Drains all CONTACT_COUNT contacts across every page, not just the
    // first server page — the single-page consumer returns SERVER_PAGE_SIZE.
    expect(peers).toHaveLength(CONTACT_COUNT);
    const names = new Set(peers.map((p) => p.name));
    expect(names.has("Peer 0")).toBe(true);
    expect(names.has(`Peer ${SERVER_PAGE_SIZE - 1}`)).toBe(true);
    expect(names.has(`Peer ${SERVER_PAGE_SIZE}`)).toBe(true);
    expect(names.has(`Peer ${CONTACT_COUNT - 1}`)).toBe(true);
    const ids = new Set(peers.map((p) => p.id));
    expect(ids.has("agent:peer-0")).toBe(true);
    expect(ids.has(`agent:peer-${CONTACT_COUNT - 1}`)).toBe(true);
  });
}

function followsNextCursorAcrossPages() {
  return Effect.gen(function* () {
    yield* listPeers();
    expect(agentsCallCount).toBe(EXPECTED_PAGE_CALLS);
  });
}

// Non-advancing cursor: the guard must TERMINATE the drain (not hang, not
// truncate-loop). Page 1 records cursor C; page 2 (sent with cursor=C)
// returns C again → already seen → typed fail. The directory's catchAll
// absorbs the error to an empty list, so the observable signal is: the
// call resolves (no hang) after a BOUNDED number of pages. Without the
// guard this loops forever and the test never resolves.
const EXPECTED_BYZANTINE_PAGE_CALLS = 2;

function terminatesOnNonAdvancingCursor() {
  return Effect.gen(function* () {
    byzantineConstantCursor = true;
    const peers = yield* listPeers();
    expect(peers).toEqual([]);
    expect(agentsCallCount).toBe(EXPECTED_BYZANTINE_PAGE_CALLS);
  });
}

function startReceiverDependentGateway(): void {
  // `callDefinition` reads `this.live`, so it only works when invoked with the
  // service as its receiver — exactly how a production `MoltZapService`
  // instance lands in `activeClients`. The directory code must bind it to
  // `service` before forwarding; an unbound forward dies on `this`-undefined.
  startGatewayWithService(
    () =>
      ({
        ...fixture.service,
        live: true,
        callDefinition: makeReceiverDependentCallDefinition(),
      }) satisfies ReceiverDependentService as ChannelService,
  );
}

function resolvesWithReceiverStrippedSendRpc() {
  return Effect.gen(function* () {
    startReceiverDependentGateway();
    const peers = yield* listPeers();
    expect(peers).toHaveLength(CONTACT_COUNT);
    const names = new Set(peers.map((p) => p.name));
    expect(names.has("Peer 0")).toBe(true);
    expect(names.has(`Peer ${CONTACT_COUNT - 1}`)).toBe(true);
  });
}

describe("directory: agents/list pagination", () => {
  it("enumerates EVERY peer across multiple agent pages", enumeratesEveryPeer);
  it(
    "follows nextCursor across pages (one agents/list call per page)",
    followsNextCursorAcrossPages,
  );
  it(
    "terminates on a non-advancing nextCursor instead of looping",
    terminatesOnNonAdvancingCursor,
  );
  it(
    "binds the sendRpc receiver so a prototype-method sendRpc does not die",
    resolvesWithReceiverStrippedSendRpc,
  );
});

function makeAccount() {
  return {
    id: ACCOUNT_ID,
    agentName: ACCOUNT_AGENT_NAME,
  };
}

function makeCfg() {
  return {
    channels: {
      moltzap: {
        accounts: [makeAccount()],
      },
    },
  };
}
