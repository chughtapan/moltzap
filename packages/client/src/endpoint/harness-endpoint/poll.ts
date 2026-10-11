/** @file Scoped polling renews consumer ownership independently of native callback duration. */

import {
  type Client,
  fromJsonSchema,
  type JsonSchemaType,
} from "@modelcontextprotocol/client";
import { Effect, Queue, Stream, Take } from "effect";
import { ListenError } from "../../transport/messaging/errors.js";
import {
  type PollResult,
  pollResultJsonSchema,
} from "../event-contract/index.js";
import { HARNESS_CONSUMER_META_KEY, INBOX_ITEM_EVENT } from "../mcp/names.js";
import { listenFailure } from "./failures.js";

const POLL_INTERVAL_FLOOR_MILLIS = 1000;
const resultSchema = fromJsonSchema<PollResult>(
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- Effect's JSON Schema is the exact validator document consumed by the pinned official MCP SDK.
  pollResultJsonSchema as JsonSchemaType,
);

interface Reception {
  readonly client: Client;
  readonly generation: string;
  readonly queue: Queue.Queue<Take.Take<string, ListenError>>;
  cursor: string;
}

const pollRequest = (
  client: Client,
  params: Readonly<Record<string, unknown>>,
) =>
  Effect.tryPromise({
    try: (signal) =>
      client.request({ method: "events/poll", params }, resultSchema, {
        signal,
      }),
    catch: listenFailure,
  });

const open = (client: Client) =>
  Effect.gen(function* () {
    const first = yield* pollRequest(client, {
      name: INBOX_ITEM_EVENT,
      arguments: {},
      cursor: null,
    });
    const queue = yield* Queue.sliding<Take.Take<string, ListenError>>(1);
    const generation = first._meta[HARNESS_CONSUMER_META_KEY].generation;
    queue.unsafeOffer(Take.of(generation));
    return {
      client,
      queue,
      generation,
      cursor: first.cursor,
    } satisfies Reception;
  });

const receive = (state: Reception) =>
  Effect.gen(function* () {
    const result = yield* pollRequest(state.client, {
      name: INBOX_ITEM_EVENT,
      arguments: {},
      cursor: state.cursor,
      _meta: { [HARNESS_CONSUMER_META_KEY]: { generation: state.generation } },
    });
    if (
      result._meta[HARNESS_CONSUMER_META_KEY].generation !== state.generation
    ) {
      return yield* Effect.fail(new ListenError({ reason: "decode-failed" }));
    }
    state.cursor = result.cursor;
    if (result.events.length !== 0 || result.truncated) {
      state.queue.unsafeOffer(Take.of(state.generation));
    }
    if (!result.hasMore) {
      yield* Effect.sleep(
        Math.max(result.nextPollMs, POLL_INTERVAL_FLOOR_MILLIS),
      );
    }
  });

const close = (state: Reception) =>
  pollRequest(state.client, {
    name: INBOX_ITEM_EVENT,
    arguments: {},
    cursor: null,
    _meta: {
      [HARNESS_CONSUMER_META_KEY]: {
        generation: state.generation,
        release: true,
      },
    },
  }).pipe(
    Effect.interruptible,
    Effect.timeoutOption("5 seconds"),
    Effect.ignore,
    Effect.ensuring(Queue.shutdown(state.queue)),
  );

/**
 * Acquires the generation before unread bootstrap and releases it on shutdown.
 * Polling continues while host callbacks run, so slow acceptance cannot expire
 * the lease. The bounded queue coalesces wakeups, never inbox content or receipts.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host
 *   participant Client
 *   participant Daemon
 *   Client->>Daemon: First poll at now
 *   Daemon-->>Client: Cursor and non-secret generation
 *   Client-->>Host: Read retained unread inbox
 *   loop While subscription is scoped
 *     Client->>Daemon: Poll with cursor and generation
 *     Daemon-->>Client: Bounded events or quiet position
 *     Client-->>Host: Coalesced unread wakeup
 *   end
 *   Client->>Daemon: Release generation in poll metadata
 * ```
 */
export const pollWakeups = (
  client: Client,
): Stream.Stream<string, ListenError> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- Stream.unwrapScoped owns this acquisition and releases it when consumption ends, including interruption.
      const state = yield* Effect.acquireRelease(open(client), close);
      yield* receive(state).pipe(
        Effect.forever,
        Effect.catchAll((error) => Queue.offer(state.queue, Take.fail(error))),
        Effect.forkScoped,
      );
      return Stream.fromQueue(state.queue).pipe(Stream.flattenTake);
    }).pipe(Effect.withSpan("pollWakeups")),
  );
