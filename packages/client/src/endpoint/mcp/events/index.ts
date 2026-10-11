/** @file Pinned MCP Events discovery and request-scoped push delivery. */

import {
  type McpServer,
  ProtocolError,
  type ServerContext,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/server";
import { Cause, Deferred, Effect, Exit, Option, Queue, Scope } from "effect";
import { randomUUID } from "node:crypto";
import type { EventStore } from "../../../delivery/operations.js";
import type { InboxSummary } from "../../../store/index.js";
import { itemEventDataJsonSchema } from "../../event-contract/index.js";
import { INBOX_ITEM_EVENT, INBOX_PENDING_EVENT } from "../names.js";
import { type HarnessPollEvents, makeHarnessPollEvents } from "./poll.js";
import {
  eventListInput,
  type EventPollInput,
  eventPollInput,
  type EventStreamInput,
  eventStreamInput,
  type EventSubscribeInput,
  eventSubscribeInput,
  type EventUnsubscribeInput,
  eventUnsubscribeInput,
  type HarnessWebhookEvents,
  type WebhookStatus,
} from "./schemas.js";
/** Durable callback delivery shares this consumer boundary. */
export { makeWebhookEvents } from "./webhook.js";
/** Owner-only diagnostics use the same closed status schema. */
export { webhookStatusJsonSchema } from "./schemas.js";
/** Effect HTTP connection policy for callback delivery. */
export { webhookHttpClientLayer } from "./signing.js";

interface ActivePush {
  readonly context: ServerContext;
  readonly stop: Deferred.Deferred<undefined>;
  readonly closed: Deferred.Deferred<undefined>;
  ready: boolean;
  previousSequence: number;
}

interface EventsOptions {
  readonly summary: () => Effect.Effect<
    InboxSummary,
    { readonly reason: string }
  >;
  /** True only while the daemon's registered protocol lifecycle is active. */
  readonly protocolActive: () => boolean;
  readonly gate: Effect.Semaphore;
  readonly webhook?: HarnessWebhookEvents;
  readonly eventStore?: EventStore;
  readonly keepAliveMillis?: number;
  readonly onActiveChange?: (active: boolean) => void;
}

/** Official SDK request handlers and the daemon's content-free wakeup edge. */
export interface HarnessEvents {
  readonly install: (server: McpServer["server"], principal?: string) => void;
  readonly hasActiveSubscription: () => boolean;
  readonly notifyPending: () => boolean;
  readonly close: Effect.Effect<void>;
  readonly status: Effect.Effect<WebhookStatus, ProtocolError>;
  readonly revoke: Effect.Effect<void, ProtocolError>;
  readonly resume: Effect.Effect<void, ProtocolError>;
  readonly nativeOperation: <A, E>(
    metadata: unknown,
    operation: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ProtocolError>;
}

/**
 * Validate the event name separately from its argument grammar for draft errors.
 * @param name Event type supplied by the caller.
 */
const requireInboxEvent = (name: string): void => {
  if (name !== INBOX_PENDING_EVENT) {
    throw new ProtocolError(-32011, "Event not found", { kind: "event" });
  }
};

const requireNoReplay = (cursor?: string | null): void => {
  if (cursor != null) {
    throw new ProtocolError(
      -32014,
      "Event replay is unavailable; read the pending inbox",
      { feature: "cursor" },
    );
  }
};

const requireProtocolActive = (options: EventsOptions): void => {
  if (!options.protocolActive()) {
    throw new ProtocolError(-32012, "Endpoint is not registered");
  }
};

const requireAvailable = (occupied: boolean): void => {
  if (occupied) {
    throw new ProtocolError(-32013, "Runtime subscription already active", {
      limit: "subscriptions",
      max: 1,
      reason: "already-listening",
    });
  }
};

const notify = (
  push: ActivePush,
  method: string,
  params: Readonly<Record<string, unknown>>,
) =>
  Effect.tryPromise({
    try: () =>
      push.context.mcpReq.notify({
        method,
        params: {
          ...params,
          _meta: { [SUBSCRIPTION_ID_META_KEY]: push.context.mcpReq.id },
        },
      }),
    catch: () => new ProtocolError(-32603, "Event transport failed"),
  });

/* eslint-disable agent-code-guard/async-keyword -- Official SDK callbacks consume a Promise at this boundary. */
/**
 * Preserve the draft's protocol errors across the Effect and SDK boundary.
 * @param operation Validated Events operation.
 * @param signal Cancellation owned by the MCP request.
 * @returns The SDK result or a sanitized protocol exception.
 */
// #ignore-sloppy-code-next-line[async-keyword]: MCP consumes this Promise-native protocol adapter.
export const runEventOperation = async <A, E>(
  operation: Effect.Effect<A, E>,
  signal: AbortSignal,
) => {
  const outcome = await Effect.runPromiseExit(operation, { signal });
  if (Exit.isSuccess(outcome)) {
    return outcome.value;
  }
  const failure = Option.getOrElse(Cause.failureOption(outcome.cause), () =>
    Option.getOrUndefined(Cause.dieOption(outcome.cause)),
  );
  throw ProtocolError.isInstance(failure)
    ? failure
    : new ProtocolError(-32603, "Event operation failed");
};

/* eslint-enable agent-code-guard/async-keyword -- Remaining operations use Effect. */

interface EventsRuntime {
  readonly options: EventsOptions;
  readonly lifetime: Scope.CloseableScope;
  readonly wakeups: Queue.Queue<boolean>;
  readonly poll?: HarnessPollEvents;
  active?: ActivePush;
  closed: boolean;
  reportedActive: boolean;
  revoking: boolean;
}
const isPolling = (runtime: EventsRuntime) =>
  runtime.poll?.hasActiveSubscription() === true;
const hasWebhook = (runtime: EventsRuntime) =>
  runtime.options.webhook?.hasActiveSubscription() === true;
const unavailable = (runtime: EventsRuntime) =>
  runtime.closed || runtime.revoking || runtime.active !== undefined;
const hasConsumer = (runtime: EventsRuntime) =>
  runtime.active !== undefined || isPolling(runtime) || hasWebhook(runtime);
const reportOwnership = (runtime: EventsRuntime) => {
  const active = hasConsumer(runtime);
  if (active !== runtime.reportedActive) {
    runtime.reportedActive = active;
    runtime.options.onActiveChange?.(active);
  }
};
const publishPush = (push: ActivePush, summary: InboxSummary) => {
  if (
    !push.ready ||
    summary.pendingCount === 0 ||
    push.previousSequence === summary.newestSequence
  ) {
    return Effect.void;
  }
  return notify(push, "notifications/events/event", {
    eventId: `evt_${randomUUID()}`,
    name: INBOX_PENDING_EVENT,
    timestamp: new Date().toISOString(),
    data: { pendingCount: summary.pendingCount },
    cursor: null,
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        push.previousSequence = summary.newestSequence;
      }),
    ),
  );
};
const dispatch = (runtime: EventsRuntime, summary: InboxSummary) => {
  const push = runtime.active;
  return push === undefined
    ? (runtime.options.webhook?.observe() ?? Effect.void)
    : publishPush(push, summary).pipe(
        Effect.catchAll(() =>
          Deferred.succeed(push.stop, undefined).pipe(Effect.asVoid),
        ),
      );
};
const publish = (runtime: EventsRuntime) =>
  runtime.options.gate
    .withPermits(1)(
      runtime.options
        .summary()
        .pipe(Effect.map((summary) => dispatch(runtime, summary))),
    )
    .pipe(
      Effect.flatten,
      Effect.tap(() =>
        Effect.sync(() => {
          reportOwnership(runtime);
        }),
      ),
      Effect.catchAll(() =>
        Effect.logWarning(
          "MCP Events delivery deferred after a persistence failure",
        ),
      ),
    );
const releasePush = (runtime: EventsRuntime, push: ActivePush) =>
  Effect.sync(() => {
    if (runtime.active === push) {
      delete runtime.active;
      reportOwnership(runtime);
    }
  }).pipe(Effect.zipRight(Deferred.succeed(push.closed, undefined)));
const keepAlive = (runtime: EventsRuntime, push: ActivePush) =>
  Effect.sleep(runtime.options.keepAliveMillis ?? 20_000).pipe(
    Effect.zipRight(
      notify(push, "notifications/events/heartbeat", { cursor: null }),
    ),
    Effect.forever,
    Effect.catchAll(() => Deferred.succeed(push.stop, undefined)),
    Effect.forkScoped,
  );
const stream = (
  runtime: EventsRuntime,
  input: EventStreamInput,
  context: ServerContext,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        requireProtocolActive(runtime.options);
        requireInboxEvent(input.name);
        requireNoReplay(input.cursor);
      });
      const stop = yield* Deferred.make<undefined>();
      const closed = yield* Deferred.make<undefined>();
      const push: ActivePush = {
        context,
        stop,
        closed,
        ready: false,
        previousSequence: -1,
      };
      yield* Effect.acquireRelease(
        runtime.options.gate.withPermits(1)(
          Effect.sync(() => {
            requireAvailable(
              runtime.closed || runtime.revoking || hasConsumer(runtime),
            );
            runtime.active = push;
          }),
        ),
        () => releasePush(runtime, push),
      );
      yield* notify(push, "notifications/events/active", {
        cursor: null,
        truncated: false,
      });
      yield* Effect.sync(() => {
        push.ready = true;
        reportOwnership(runtime);
        runtime.wakeups.unsafeOffer(true);
      });
      yield* keepAlive(runtime, push);
      yield* Deferred.await(stop);
      return {};
    }),
  );

const descriptor = () => ({
  name: INBOX_PENDING_EVENT,
  description:
    "Runtime wakeup for pending MoltZap items. Native clients manage inbox consumption and handoff.",
  delivery: ["push"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: {
    type: "object",
    properties: { pendingCount: { type: "integer", minimum: 0 } },
    required: ["pendingCount"],
    additionalProperties: false,
  },
});
const streamForPrincipal = (
  runtime: EventsRuntime,
  input: EventStreamInput,
  context: ServerContext,
  principal: string,
) =>
  principal === "runtime"
    ? Effect.fail(
        new ProtocolError(-32014, "Native inbox streaming is unavailable", {
          feature: "stream",
        }),
      )
    : stream(runtime, input, context);

const itemDescriptor = (runtime: EventsRuntime) => ({
  name: INBOX_ITEM_EVENT,
  description:
    "A MoltZap message, collective request, result, or failure. Large events reference their full content through read_event. Processing and notifications follow the user's task configuration.",
  delivery: [
    ...(runtime.poll === undefined ? [] : ["poll"]),
    ...(runtime.options.webhook === undefined ? [] : ["webhook"]),
  ],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: itemEventDataJsonSchema,
});
const eventCatalog = (runtime: EventsRuntime, principal: string) => [
  ...(principal === "runtime" ? [] : [descriptor()]),
  ...(runtime.poll !== undefined || runtime.options.webhook !== undefined
    ? [itemDescriptor(runtime)]
    : []),
];

const installReadHandlers = (
  runtime: EventsRuntime,
  server: McpServer["server"],
  principal = "local",
) => {
  server.setRequestHandler(
    "events/list",
    { params: eventListInput },
    (input) => {
      if (input.cursor !== undefined) {
        throw new ProtocolError(-32602, "Invalid event catalog cursor");
      }
      return { events: eventCatalog(runtime, principal) };
    },
  );
  server.setRequestHandler(
    "events/stream",
    { params: eventStreamInput },
    (input, context) =>
      runEventOperation(
        streamForPrincipal(runtime, input, context, principal),
        context.mcpReq.signal,
      ),
  );
};
const subscribe = (
  runtime: EventsRuntime,
  input: EventSubscribeInput,
  principal?: string,
) => {
  requireProtocolActive(runtime.options);
  if (input.name !== INBOX_ITEM_EVENT) {
    throw new ProtocolError(-32011, "Event not found", { kind: "event" });
  }
  requireNoReplay(input.cursor);
  const webhook = runtime.options.webhook;
  if (
    webhook === undefined ||
    principal === undefined ||
    input.delivery.mode !== "webhook"
  ) {
    throw new ProtocolError(-32014, "Webhook delivery is unavailable", {
      feature: "deliveryMode",
      value: input.delivery.mode,
    });
  }
  return webhook
    .subscribe(
      input,
      principal,
      Effect.sync(() => {
        requireAvailable(unavailable(runtime) || isPolling(runtime));
      }),
    )
    .pipe(
      Effect.map((grant) => ({ ...grant })),
      Effect.tap(() =>
        Effect.sync(() => {
          reportOwnership(runtime);
          runtime.wakeups.unsafeOffer(true);
        }),
      ),
    );
};
const unsubscribe = (
  runtime: EventsRuntime,
  input: EventUnsubscribeInput,
  principal?: string,
) => {
  if (input.name !== INBOX_ITEM_EVENT) {
    throw new ProtocolError(-32011, "Event not found", { kind: "event" });
  }
  const webhook = runtime.options.webhook;
  if (webhook === undefined || principal === undefined) {
    throw new ProtocolError(-32011, "Subscription not found", {
      kind: "subscription",
    });
  }
  return webhook.unsubscribe(input, principal).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        reportOwnership(runtime);
      }),
    ),
    Effect.as({}),
  );
};
const install = (
  runtime: EventsRuntime,
  server: McpServer["server"],
  principal = "local",
) => {
  installReadHandlers(runtime, server, principal);
  server.setRequestHandler(
    "events/poll",
    { params: eventPollInput },
    (input, context) =>
      runEventOperation(
        poll(runtime, input, context.mcpReq._meta),
        context.mcpReq.signal,
      ),
  );
  server.setRequestHandler(
    "events/subscribe",
    { params: eventSubscribeInput },
    (input, context) =>
      runEventOperation(
        subscribe(runtime, input, principal),
        context.mcpReq.signal,
      ),
  );
  server.setRequestHandler(
    "events/unsubscribe",
    { params: eventUnsubscribeInput },
    (input, context) =>
      runEventOperation(
        unsubscribe(runtime, input, principal),
        context.mcpReq.signal,
      ),
  );
};

/**
 * Poll reserves the same consumer slot as native push and durable callbacks.
 * @param runtime Shared consumer ownership and lifecycle.
 * @param input Validated draft polling request.
 * @param metadata Request-owned lifecycle binding, never management authority.
 * @returns A bounded replay page or a closed protocol refusal.
 */
function poll(
  runtime: EventsRuntime,
  input: EventPollInput,
  metadata: unknown,
) {
  return Effect.suspend(() => {
    requireProtocolActive(runtime.options);
    if (runtime.poll === undefined) {
      return Effect.fail(
        new ProtocolError(-32014, "Native polling is unavailable", {
          feature: "poll",
        }),
      );
    }
    return runtime.poll
      .poll(
        input,
        metadata,
        Effect.sync(() => {
          requireAvailable(unavailable(runtime) || hasWebhook(runtime));
        }),
      )
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            reportOwnership(runtime);
          }),
        ),
      );
  });
}
const close = (runtime: EventsRuntime) =>
  Effect.gen(function* () {
    runtime.closed = true;
    yield* runtime.poll?.revoke ?? Effect.void;
    const push = runtime.active;
    if (push !== undefined) {
      yield* Deferred.succeed(push.stop, undefined);
      yield* Deferred.await(push.closed);
    }
    yield* Scope.close(runtime.lifetime, Exit.void);
  });
const status = (
  runtime: EventsRuntime,
): Effect.Effect<WebhookStatus, ProtocolError> =>
  Effect.suspend(() => {
    if (runtime.active !== undefined) {
      return Effect.succeed({ mode: "push" });
    }
    if (runtime.poll?.hasActiveSubscription() === true) {
      return runtime.poll.status;
    }
    return runtime.options.webhook?.status ?? Effect.succeed({ mode: "none" });
  });
const revoke = (runtime: EventsRuntime) =>
  Effect.gen(function* () {
    yield* runtime.options.gate.withPermits(1)(
      Effect.gen(function* () {
        runtime.revoking = true;
        if (runtime.active !== undefined) {
          yield* Deferred.succeed(runtime.active.stop, undefined);
        }
      }),
    );
    yield* runtime.poll?.revoke ?? Effect.void;
    yield* runtime.options.webhook?.revoke ?? Effect.void;
  }).pipe(
    Effect.ensuring(
      runtime.options.gate.withPermits(1)(
        Effect.sync(() => {
          runtime.revoking = false;
          reportOwnership(runtime);
        }),
      ),
    ),
    Effect.uninterruptible,
  );
const assembled = (runtime: EventsRuntime): HarnessEvents => ({
  install: (server, principal) => {
    install(runtime, server, principal);
  },
  hasActiveSubscription: () => hasConsumer(runtime),
  notifyPending: () => {
    if (runtime.closed) {
      return false;
    }
    runtime.wakeups.unsafeOffer(true);
    return true;
  },
  close: close(runtime),
  status: status(runtime),
  revoke: revoke(runtime),
  resume: (runtime.options.webhook?.resume ?? Effect.void).pipe(
    Effect.tap(() => Effect.sync(() => runtime.wakeups.unsafeOffer(true))),
  ),
  nativeOperation: (metadata, operation) =>
    runtime.poll === undefined
      ? Effect.fail(
          new ProtocolError(-32014, "Native polling is unavailable", {
            feature: "poll",
          }),
        )
      : runtime.poll.nativeOperation(metadata, operation),
});

/**
 * Own one consumer while the official SDK handles request validation and framing.
 * @param options Classified inbox counters, callback edge and lifecycle.
 * @returns SDK installers and an explicit close for retained event resources.
 */
export const makeHarnessEvents = (
  options: EventsOptions,
): Effect.Effect<HarnessEvents> =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.make();
    const wakeups = yield* Queue.sliding<boolean>(1);
    const poll =
      options.eventStore === undefined
        ? undefined
        : yield* makeHarnessPollEvents(options.eventStore, options.gate);
    const runtime: EventsRuntime = {
      options,
      lifetime,
      wakeups,
      closed: false,
      reportedActive: false,
      revoking: false,
      ...(poll === undefined ? {} : { poll }),
    };
    yield* Scope.addFinalizer(lifetime, Queue.shutdown(wakeups));
    yield* Queue.take(wakeups).pipe(
      Effect.zipRight(publish(runtime)),
      Effect.forever,
      Effect.forkIn(lifetime),
    );
    if (options.webhook !== undefined || poll !== undefined) {
      yield* Effect.sleep(1000).pipe(
        Effect.tap(() => Effect.sync(() => wakeups.unsafeOffer(true))),
        Effect.forever,
        Effect.forkIn(lifetime),
      );
      wakeups.unsafeOffer(true);
    }
    return assembled(runtime);
  }).pipe(Effect.withSpan("makeHarnessEvents"));
