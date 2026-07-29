import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";

const it = effectIt.effect;
import { agentId, agentsList } from "@moltzap/protocol/identity";
import { listCursorSchema } from "@moltzap/protocol/rpc";
import type { ClientDefinitionSuccess } from "@moltzap/protocol/socket";
import {
  drainPaginatedList,
  NonAdvancingCursorError,
  type SendRpcFn,
} from "./pagination.js";

// The drainer is wire-generic; we exercise it through `agent/identity/agents/list`
// because its result is the `{ agents: T[], nextCursor? }` shape the
// drain enumerates. The fake `sendRpc` never fails,
// so the ONLY error channel left is the cursor-cycle guard — keeping the
// non-advancing assertion non-vacuous.

const PAGE_SIZE = 2;
const TOTAL = 5;
const EXPECTED_PAGE_CALLS = Math.ceil(TOTAL / PAGE_SIZE);
const decodeCursor = Schema.decodeSync(listCursorSchema());
const decodeAgentId = Schema.decodeSync(agentId);
const CONSTANT_CURSOR = decodeCursor("stuck-cursor");

type AgentListPage = ClientDefinitionSuccess<typeof agentsList>;
type FakeAgent = AgentListPage["agents"][number];
type AgentListCursor = NonNullable<AgentListPage["nextCursor"]>;

const ALL_AGENTS: ReadonlyArray<FakeAgent> = Array.from(
  { length: TOTAL },
  (_unused, i) => ({
    id: decodeAgentId(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    name: `agent-${i}`,
    status: "active",
  }),
);

// Keyset paging over an opaque cursor: the cursor encodes the index of
// the first row of the NEXT page. `nextCursor` present iff more rows
// remain (Invariant 1: a present cursor means a further page exists).
function pagingSendRpc(): {
  readonly send: SendRpcFn<never, typeof agentsList>;
  callCount: () => number;
} {
  let calls = 0;
  const send: SendRpcFn<never, typeof agentsList> = (_definition, params) => {
    calls++;
    const cursor = params.cursor;
    const start = cursor === undefined ? 0 : Number(cursor);
    const slice = ALL_AGENTS.slice(start, start + PAGE_SIZE);
    const nextStart = start + PAGE_SIZE;
    const hasMore = nextStart < ALL_AGENTS.length;
    const page: AgentListPage = hasMore
      ? { agents: slice, nextCursor: decodeCursor(String(nextStart)) }
      : { agents: slice };
    return Effect.succeed(page);
  };
  return { send, callCount: () => calls };
}

// Byzantine server: always claims "more" with the SAME cursor — the
// drain must terminate via the cycle guard rather than loop forever.
function nonAdvancingSendRpc(): {
  readonly send: SendRpcFn<never, typeof agentsList>;
  callCount: () => number;
} {
  let calls = 0;
  const send: SendRpcFn<never, typeof agentsList> = () => {
    calls++;
    const page: AgentListPage = {
      agents: ALL_AGENTS.slice(0, PAGE_SIZE),
      nextCursor: CONSTANT_CURSOR,
    };
    return Effect.succeed(page);
  };
  return { send, callCount: () => calls };
}

function agentName(agent: FakeAgent): string {
  return agent.name;
}

function agentListParams(cursor: AgentListCursor | undefined) {
  return cursor === undefined ? {} : { cursor };
}

function agentRows(page: AgentListPage): ReadonlyArray<FakeAgent> {
  return page.agents;
}

function agentNextCursor(page: AgentListPage): AgentListCursor | undefined {
  return page.nextCursor;
}

const EXPECTED_NAMES = ALL_AGENTS.map(agentName);

describe("drainPaginatedList", () => {
  it("drains every page, following nextCursor to the tail", () =>
    Effect.gen(function* () {
      const fake = pagingSendRpc();
      const contacts = yield* drainPaginatedList<
        never,
        typeof agentsList,
        FakeAgent,
        AgentListCursor
      >({
        sendRpc: fake.send,
        definition: agentsList,
        paramsForCursor: agentListParams,
        rowsForPage: agentRows,
        nextCursorForPage: agentNextCursor,
      });
      expect(contacts).toHaveLength(TOTAL);
      const names = contacts.map(agentName);
      expect(names).toEqual(EXPECTED_NAMES);
      // One RPC call per page — no over-fetch, no truncation.
      expect(fake.callCount()).toBe(EXPECTED_PAGE_CALLS);
    }));

  it("fails with NonAdvancingCursorError on a repeated cursor (cycle guard)", () =>
    Effect.gen(function* () {
      const fake = nonAdvancingSendRpc();
      const error = yield* drainPaginatedList<
        never,
        typeof agentsList,
        FakeAgent,
        AgentListCursor
      >({
        sendRpc: fake.send,
        definition: agentsList,
        paramsForCursor: agentListParams,
        rowsForPage: agentRows,
        nextCursorForPage: agentNextCursor,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(NonAdvancingCursorError);
      expect(error.method).toBe(agentsList.name);
      // Page 1 records cursor C; page 2 (sent with cursor=C) returns C
      // again → already seen → typed fail. Bounded at 2 calls, no loop.
      expect(fake.callCount()).toBe(2);
    }));
});
