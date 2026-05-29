import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect } from "effect";

const it = effectIt.effect;
import {
  ContactsList,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import {
  drainPaginatedList,
  NonAdvancingCursorError,
  type SendRpcFn,
} from "./pagination.js";

// The drainer is wire-generic; we exercise it through `contacts/list`
// because its result is the `{ contacts: T[], nextCursor? }` shape the
// drain enumerates. The fake `sendRpc` never fails (`SendRpcFn<never>`),
// so the ONLY error channel left is the cursor-cycle guard — keeping the
// non-advancing assertion non-vacuous.

const PAGE_SIZE = 2;
const TOTAL = 5;
const EXPECTED_PAGE_CALLS = Math.ceil(TOTAL / PAGE_SIZE);
const CONSTANT_CURSOR = "stuck-cursor";

interface FakeContact {
  readonly id: string;
}

const ALL_CONTACTS: ReadonlyArray<FakeContact> = Array.from(
  { length: TOTAL },
  (_unused, i) => ({ id: `contact-${i}` }),
);

// Keyset paging over an opaque cursor: the cursor encodes the index of
// the first row of the NEXT page. `nextCursor` present iff more rows
// remain (Invariant 1: a present cursor means a further page exists).
function pagingSendRpc(): {
  readonly send: SendRpcFn<never>;
  callCount: () => number;
} {
  let calls = 0;
  const send = (<D extends RpcDefinition<string, any, any>>(
    _definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, never> => {
    calls++;
    const cursor = (params as { readonly cursor?: string }).cursor;
    const start = cursor === undefined ? 0 : Number(cursor);
    const slice = ALL_CONTACTS.slice(start, start + PAGE_SIZE);
    const nextStart = start + PAGE_SIZE;
    const hasMore = nextStart < ALL_CONTACTS.length;
    return Effect.succeed(
      (hasMore
        ? { contacts: slice, nextCursor: String(nextStart) }
        : { contacts: slice }) as ResultOf<D>,
    );
  }) as SendRpcFn<never>;
  return { send, callCount: () => calls };
}

// Byzantine server: always claims "more" with the SAME cursor — the
// drain must terminate via the cycle guard rather than loop forever.
function nonAdvancingSendRpc(): {
  readonly send: SendRpcFn<never>;
  callCount: () => number;
} {
  let calls = 0;
  const send = (<D extends RpcDefinition<string, any, any>>(
    _definition: D,
    _params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, never> => {
    calls++;
    return Effect.succeed({
      contacts: ALL_CONTACTS.slice(0, PAGE_SIZE),
      nextCursor: CONSTANT_CURSOR,
    } as ResultOf<D>);
  }) as SendRpcFn<never>;
  return { send, callCount: () => calls };
}

function contactId(c: FakeContact): string {
  return c.id;
}

const EXPECTED_IDS = ALL_CONTACTS.map(contactId);

describe("drainPaginatedList", () => {
  it("drains every page, following nextCursor to the tail", () =>
    Effect.gen(function* () {
      const fake = pagingSendRpc();
      const contacts = yield* drainPaginatedList(
        fake.send,
        ContactsList,
        "contacts",
      );
      expect(contacts).toHaveLength(TOTAL);
      const ids = (contacts as ReadonlyArray<FakeContact>).map(contactId);
      expect(ids).toEqual(EXPECTED_IDS);
      // One RPC call per page — no over-fetch, no truncation.
      expect(fake.callCount()).toBe(EXPECTED_PAGE_CALLS);
    }));

  it("fails with NonAdvancingCursorError on a repeated cursor (cycle guard)", () =>
    Effect.gen(function* () {
      const fake = nonAdvancingSendRpc();
      const error = yield* drainPaginatedList(
        fake.send,
        ContactsList,
        "contacts",
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(NonAdvancingCursorError);
      expect(error.method).toBe(ContactsList.name);
      // Page 1 records cursor C; page 2 (sent with cursor=C) returns C
      // again → already seen → typed fail. Bounded at 2 calls, no loop.
      expect(fake.callCount()).toBe(2);
    }));
});
