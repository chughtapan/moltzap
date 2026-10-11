/** @file Pins bounded inbox reads, snapshot continuations and SQLite cursor release. */

import type { SQLOutputValue } from "node:sqlite";
import { Effect, FastCheck as fc, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  stateDirectory,
  withStore,
} from "../__tests__/store-schema-fixtures.js";
import {
  closeStoreState,
  openStoreState,
  runStoreOperation,
  StoreSignal,
  type StoreState,
} from "./database/index.js";
import {
  acknowledgeInboxItem,
  putInboxItem,
  readInbox,
  readInboxItem,
  readInboxSummary,
} from "./inbox.js";
import { DeliveryToken, type InboxEntry } from "./index.js";

const PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_ITEMS = 50;

describe("bounded inbox reads", () => {
  it(
    "materializes only a byte-bounded page and one overflow row",
    boundsMaterialization,
  );
  it(
    "keeps overflow rows reachable without extending the snapshot",
    retainsOverflow,
  );
  it("includes items that exactly fill the byte budget", fillsByteBudget);
  it(
    "stops at the requested item limit and releases the cursor",
    boundsItemCount,
  );
  it("preserves the default maximum item count", preservesDefaultLimit);
  it("does not acknowledge items by reading them", retainsUnreadItems);
  it(
    "skips newly acknowledged rows within an existing continuation",
    skipsAcknowledgedItems,
  );
  it(
    "releases the cursor after fully consuming its snapshot",
    closesConsumedCursor,
  );
  it("returns an empty page without a continuation", readsEmptyInbox);
  it("releases the cursor when row decoding fails", closesCorruptCursor);
  it(
    "releases the cursor when SQLite cannot produce the next row",
    closesFailedCursor,
  );
  it.each([
    { limit: 0 },
    { limit: PAGE_ITEMS + 1 },
    { limit: 1.5 },
    { after: -1 },
    { after: Number.MAX_SAFE_INTEGER + 1 },
    { through: -1 },
    { after: 1, through: 0 },
  ])("rejects invalid continuation bounds %j", rejectsInvalidBounds);
  it("retains unread items across store restart", retainsItemsAcrossRestart);
  it(
    "recovers every generated inbox through bounded pages",
    recoversGeneratedInboxes,
  );
});

function boundsMaterialization() {
  withInboxState(({ database }) => {
    const first = item(1, PAGE_BYTES);
    const second = item(2, PAGE_BYTES);
    const third = item(3, PAGE_BYTES);
    putItems(database, [first, second, third]);
    const materialized = observeMaterialization(database);

    const page = readInbox(database);

    expectInboxItems(page.items, [{ ...first, sequence: 1 }]);
    expect(materialized).toEqual([first.deliveryToken, second.deliveryToken]);
    expect(page.nextAfter).toEqual(page.items.at(-1)?.sequence);
    database.exec("DROP VIEW runtime_inbox; DROP TABLE retained_runtime_inbox");
  });
}

function retainsOverflow() {
  withInboxState(({ database }) => {
    const first = item(1, PAGE_BYTES);
    const second = item(2, PAGE_BYTES);
    const third = item(3, PAGE_BYTES);
    const arrival = item(4);
    putItems(database, [first, second, third]);

    const page = readInbox(database);
    putInboxItem(database, arrival);
    const next = readInbox(database, {
      after: page.nextAfter,
      through: page.through,
    });
    const last = readInbox(database, {
      after: next.nextAfter,
      through: page.through,
    });

    expectInboxItems(next.items, [{ ...second, sequence: 2 }]);
    expectInboxItems(last.items, [{ ...third, sequence: 3 }]);
    expect(last.through).toEqual(page.through);
    expect(last.nextAfter).toBeUndefined();
    expect(readInbox(database, { after: page.through }).items).toEqual([
      { ...arrival, sequence: 4 },
    ]);
  });
}

function fillsByteBudget() {
  withInboxState(({ database }) => {
    const first = item(1, PAGE_BYTES / 2);
    const second = item(2, PAGE_BYTES / 2);
    const overflow = item(3);
    putItems(database, [first, second, overflow]);

    const page = readInbox(database);

    expectInboxItems(page.items, [
      { ...first, sequence: 1 },
      { ...second, sequence: 2 },
    ]);
    expect(page.nextAfter).toEqual(page.items.at(-1)?.sequence);
  });
}

function boundsItemCount() {
  withInboxState(({ database }) => {
    const first = item(1);
    const second = item(2);
    const third = item(3);
    putItems(database, [first, second, third]);
    const materialized = observeMaterialization(database);

    const page = readInbox(database, { limit: 1 });

    expect(page.items).toEqual([{ ...first, sequence: 1 }]);
    expect(materialized).toEqual([first.deliveryToken, second.deliveryToken]);
    database.exec("DROP VIEW runtime_inbox; DROP TABLE retained_runtime_inbox");
  });
}

function preservesDefaultLimit() {
  withInboxState(({ database }) => {
    const items: Array<Omit<InboxEntry, "sequence">> = [];
    for (let index = 0; index <= PAGE_ITEMS; index += 1) {
      items.push(item(index));
    }
    putItems(database, items);

    const page = readInbox(database);

    expect(page.items.map((entry) => entry.deliveryToken)).toEqual(
      items.slice(0, PAGE_ITEMS).map((entry) => entry.deliveryToken),
    );
    expect(page.nextAfter).toEqual(page.items.at(-1)?.sequence);
  });
}

function retainsUnreadItems() {
  withInboxState(({ database }) => {
    const first = item(1);
    const second = item(2);
    putItems(database, [first, second]);
    const before = readInboxSummary(database);

    const page = readInbox(database);

    expect(readInbox(database)).toEqual(page);
    expect(readInboxSummary(database)).toEqual(before);
    expect(readInboxItem(database, first.deliveryToken)).toEqual({
      ...first,
      sequence: 1,
      acknowledged: false,
    });
  });
}

function skipsAcknowledgedItems() {
  withInboxState(({ database }) => {
    const first = item(1);
    const second = item(2);
    const third = item(3);
    putItems(database, [first, second, third]);
    const page = readInbox(database, { limit: 1 });
    acknowledgeInboxItem(database, second.deliveryToken);

    const next = readInbox(database, {
      after: page.nextAfter,
      through: page.through,
    });

    expect(next).toEqual({
      items: [{ ...third, sequence: 3 }],
      through: page.through,
    });
  });
}

function closesConsumedCursor() {
  withInboxState(({ database }) => {
    const first = item(1);
    putInboxItem(database, first);
    observeMaterialization(database);

    const page = readInbox(database);

    expect(page).toEqual({ items: [{ ...first, sequence: 1 }], through: 1 });
    database.exec("DROP VIEW runtime_inbox; DROP TABLE retained_runtime_inbox");
  });
}

function readsEmptyInbox() {
  withInboxState(({ database }) => {
    expect(readInbox(database)).toEqual({ items: [], through: 0 });
  });
}

function closesCorruptCursor() {
  withInboxState((state) => {
    putInboxItem(state.database, item(1));
    observeMaterialization(state.database, () => null);

    const failure = Effect.runSync(
      Effect.flip(runStoreOperation(state, () => readInbox(state.database))),
    );

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- Corrupt stored bytes must surface this closed store error.
    expect(failure.reason).toEqual("corrupt");
    state.database.exec(
      "DROP VIEW runtime_inbox; DROP TABLE retained_runtime_inbox",
    );
  });
}

function closesFailedCursor() {
  withInboxState((state) => {
    putItems(state.database, [item(1), item(2)]);
    let reads = 0;
    observeMaterialization(state.database, (canonicalItem) => {
      reads += 1;
      if (reads > 1) {
        throw new StoreSignal("persistence");
      }
      return canonicalItem;
    });

    const failure = Effect.runSync(
      Effect.flip(runStoreOperation(state, () => readInbox(state.database))),
    );

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- SQLite iteration failure must surface this closed store error.
    expect(failure.reason).toEqual("persistence");
    state.database.exec(
      "DROP VIEW runtime_inbox; DROP TABLE retained_runtime_inbox",
    );
  });
}

function rejectsInvalidBounds(input: Parameters<typeof readInbox>[1]) {
  withInboxState(({ database }) => {
    expect(() => readInbox(database, input)).toThrowError(
      new StoreSignal("invalid-continuation"),
    );
  });
}

function retainsItemsAcrossRestart() {
  const directory = stateDirectory();
  const first = item(1, PAGE_BYTES);
  const second = item(2, PAGE_BYTES);
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* withStore(directory, (store) =>
        Effect.gen(function* () {
          yield* store.putInboxItem(first);
          yield* store.putInboxItem(second);
          yield* store.readInbox({});
        }),
      );
      yield* withStore(directory, (store) =>
        Effect.gen(function* () {
          const page = yield* store.readInbox({});
          expectInboxItems(page.items, [{ ...first, sequence: 1 }]);
          const next = yield* store.readInbox({
            after: page.nextAfter,
            through: page.through,
          });
          expectInboxItems(next.items, [{ ...second, sequence: 2 }]);
        }),
      );
    }),
  );
}

function recoversGeneratedInboxes() {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(1, PAGE_BYTES / 4, PAGE_BYTES / 2, PAGE_BYTES), {
        maxLength: 12,
      }),
      fc.integer({ min: 1, max: PAGE_ITEMS }),
      readsEveryPage,
    ),
    { numRuns: 30 },
  );
}

function readsEveryPage(sizes: readonly number[], limit: number) {
  withInboxState(({ database }) => {
    const items = sizes.map((size, index) => ({
      ...item(index, size),
      sequence: index + 1,
    }));
    putItems(database, items);
    const materialized = observeMaterialization(database);
    const received: InboxEntry[] = [];
    let after = 0;
    let nextAfter: number | undefined;
    do {
      materialized.length = 0;
      const page = readInbox(database, { after, through: items.length, limit });
      expect(page.items.length).toBeLessThanOrEqual(limit);
      expect(
        page.items.reduce(
          (bytes, entry) => bytes + entry.canonicalItem.byteLength,
          0,
        ),
      ).toBeLessThanOrEqual(PAGE_BYTES);
      expect(materialized.length).toBeLessThanOrEqual(page.items.length + 1);
      received.push(...page.items);
      nextAfter = page.nextAfter;
      if (nextAfter !== undefined) {
        expect(nextAfter).toBeGreaterThan(after);
        after = nextAfter;
      }
    } while (nextAfter !== undefined);
    expectInboxItems(received, items);
    expect(readInboxSummary(database).pendingCount).toEqual(items.length);
    database.exec("DROP VIEW runtime_inbox; DROP TABLE retained_runtime_inbox");
  });
}

/** Compares payload bytes natively so large-page assertions stay inexpensive. */
function expectInboxItems(
  actual: readonly InboxEntry[],
  expected: readonly InboxEntry[],
): void {
  const metadata = (entry: InboxEntry) => ({
    sequence: entry.sequence,
    deliveryToken: entry.deliveryToken,
  });
  expect(actual.map(metadata)).toEqual(expected.map(metadata));
  for (const [index, entry] of expected.entries()) {
    const actualItem = actual[index];
    if (actualItem === undefined) {
      expect.fail("Expected an inbox item at the matching page position.");
    }
    expect(
      Buffer.from(actualItem.canonicalItem).equals(entry.canonicalItem),
    ).toBe(true);
  }
}

function item(byte: number, byteLength = 1): Omit<InboxEntry, "sequence"> {
  return {
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", byte),
    ),
    canonicalItem: new Uint8Array(byteLength).fill(byte),
  };
}

/** Uses the real store schema and closes SQLite before its directory is removed. */
function withInboxState(use: (state: StoreState) => void): void {
  Effect.runSync(
    Effect.scoped(
      Effect.acquireRelease(
        openStoreState(stateDirectory()),
        closeStoreState,
      ).pipe(
        Effect.flatMap((state) =>
          Effect.sync(() => {
            use(state);
          }),
        ),
      ),
    ),
  );
}

function putItems(
  database: StoreState["database"],
  items: ReadonlyArray<Omit<InboxEntry, "sequence">>,
): void {
  for (const entry of items) {
    putInboxItem(database, entry);
  }
}

/** SQLite invokes the probe only when a selected payload is materialized. */
function observeMaterialization(
  database: StoreState["database"],
  transform?: (canonicalItem: SQLOutputValue) => SQLOutputValue,
): SQLOutputValue[] {
  const materialized: SQLOutputValue[] = [];
  database.function("observe_inbox_item", (deliveryToken, canonicalItem) => {
    materialized.push(deliveryToken);
    return transform === undefined ? canonicalItem : transform(canonicalItem);
  });
  database.exec(
    "ALTER TABLE runtime_inbox RENAME TO retained_runtime_inbox; CREATE VIEW runtime_inbox AS SELECT sequence, delivery_token, observe_inbox_item(delivery_token, canonical_item) AS canonical_item, acknowledged FROM retained_runtime_inbox",
  );
  return materialized;
}
