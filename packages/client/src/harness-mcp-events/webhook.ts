/** @file Durable MCP webhook registration and content-free inbox wakeups. */

import { HttpClient } from "@effect/platform";
import { ProtocolError } from "@modelcontextprotocol/server";
import { type Clock, Effect, Schema } from "effect";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  type InboxSummary,
} from "../endpoint/store.js";
import { INBOX_PENDING_EVENT } from "../harness-mcp-contract.js";
import {
  callbackReasons,
  type EventSubscribeInput,
  type HarnessWebhookEvents,
  type WebhookStatus,
} from "./contract.js";
import {
  readWebhookChallenge,
  sendWebhook,
  validWebhookSecret,
  type WebhookCallbackError,
  type WebhookFailureReason,
  webhookUrl,
} from "./http.js";

const reminderDelay = 5 * 60_000;
const maximumReminders = 6;
const maximumLease = 24 * 60 * 60_000;
const verificationLifetime = 10 * 60_000;
const outboxSchema = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  sequence: Schema.NonNegativeInt,
  attempts: Schema.NonNegativeInt,
  firstAttemptAt: Schema.NonNegativeInt,
  nextAttemptAt: Schema.NonNegativeInt,
});
const registrationSchema = Schema.Struct({
  id: Schema.String,
  principal: Schema.String,
  url: Schema.String,
  secret: Schema.String,
  expiresAt: Schema.NonNegativeInt,
  sequence: Schema.NonNegativeInt,
  pendingCount: Schema.NonNegativeInt,
  reminders: Schema.NonNegativeInt,
  reminderAt: Schema.NonNegativeInt,
  stalled: Schema.NullOr(Schema.Literal("callback", "unhandled")),
  lastError: Schema.NullOr(Schema.Literal(...callbackReasons)),
  outbox: Schema.NullOr(outboxSchema),
});
const stateSchema = Schema.Struct({
  registration: Schema.NullOr(registrationSchema),
});
const challengeSchema = Schema.parseJson(
  Schema.Struct({ challenge: Schema.String }),
);
type Registration = typeof registrationSchema.Type;
type State = typeof stateSchema.Type;

const persistenceFailure = () =>
  new ProtocolError(-32603, "Event persistence failed");
const callbackFailure = (reason: WebhookFailureReason) =>
  new ProtocolError(-32015, "Callback verification failed", { reason });
const subscriptionId = (principal: string, url: string) =>
  `sub_${createHash("sha256")
    .update(JSON.stringify([principal, url, INBOX_PENDING_EVENT, {}]))
    .digest("hex")}`;

type EventStore = Pick<EndpointStore, "readEventState" | "writeEventState">;
interface WebhookRuntime {
  readonly store: EventStore;
  readonly client: HttpClient.HttpClient;
  readonly clock: Clock.Clock;
  readonly gate: Effect.Semaphore;
  readonly deliveryGate: Effect.Semaphore;
  verified?: { readonly id: string; readonly until: number };
  generation: number;
  state: State;
}
const now = (runtime: WebhookRuntime) =>
  runtime.clock.unsafeCurrentTimeMillis();
const active = (runtime: WebhookRuntime) =>
  runtime.state.registration !== null &&
  runtime.state.registration.expiresAt > now(runtime);
const save = (runtime: WebhookRuntime, registration: Registration | null) =>
  encodeRuntimeValue({ registration }).pipe(
    Effect.flatMap(runtime.store.writeEventState),
    Effect.mapError(persistenceFailure),
    Effect.tap(() =>
      Effect.sync(() => {
        runtime.state = { registration };
      }),
    ),
    Effect.uninterruptible,
  );
const retire = (runtime: WebhookRuntime) =>
  save(runtime, null).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        runtime.generation += 1;
      }),
    ),
    Effect.uninterruptible,
  );
const expire = (runtime: WebhookRuntime) =>
  Effect.suspend(() =>
    runtime.state.registration !== null && !active(runtime)
      ? retire(runtime)
      : Effect.void,
  );
const post = (
  runtime: WebhookRuntime,
  input: Parameters<typeof sendWebhook>[0],
) =>
  sendWebhook(input).pipe(
    Effect.provideService(HttpClient.HttpClient, runtime.client),
  );

const verify = (
  runtime: WebhookRuntime,
  input: { readonly id: string; readonly url: string; readonly secret: string },
) =>
  Effect.gen(function* () {
    if (
      runtime.verified?.id === input.id &&
      runtime.verified.until > now(runtime)
    ) {
      return;
    }
    const challenge = randomUUID();
    const response = yield* readWebhookChallenge({
      ...input,
      subscriptionId: input.id,
      messageId: `msg_verification_${randomUUID()}`,
      body: JSON.stringify({ type: "verification", challenge }),
      timestamp: now(runtime),
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, runtime.client),
      Effect.mapError((error) => callbackFailure(error.reason)),
    );
    const decoded = yield* Schema.decodeUnknown(challengeSchema)(response).pipe(
      Effect.mapError(() => callbackFailure("challenge_failed")),
    );
    const expected = Buffer.from(challenge);
    const received = Buffer.from(decoded.challenge);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      return yield* Effect.fail(callbackFailure("challenge_failed"));
    }
    runtime.verified = {
      id: input.id,
      until: now(runtime) + verificationLifetime,
    };
  });

const resetAttempt = (
  registration: Registration,
  timestamp: number,
): Registration["outbox"] =>
  registration.outbox === null
    ? null
    : {
        ...registration.outbox,
        attempts: 0,
        firstAttemptAt: timestamp,
        nextAttemptAt: timestamp,
      };
const refresh = (
  previous: Registration,
  secret: string,
  expiresAt: number,
  timestamp: number,
): Registration => ({
  ...previous,
  secret,
  expiresAt,
  stalled: previous.stalled === "callback" ? null : previous.stalled,
  outbox: resetAttempt(previous, timestamp),
});
const initialRegistration = (input: {
  readonly id: string;
  readonly principal: string;
  readonly url: string;
  readonly secret: string;
  readonly expiresAt: number;
}): Registration => ({
  ...input,
  sequence: 0,
  pendingCount: 0,
  reminders: 0,
  reminderAt: 0,
  stalled: null,
  lastError: null,
  outbox: null,
});

const checkRegistration = (runtime: WebhookRuntime, id: string) =>
  Effect.suspend(() =>
    runtime.state.registration !== null && runtime.state.registration.id !== id
      ? Effect.fail(
          new ProtocolError(-32013, "Runtime subscription already active", {
            limit: "subscriptions",
            max: 1,
          }),
        )
      : Effect.void,
  );

const activateRegistration = (
  runtime: WebhookRuntime,
  input: EventSubscribeInput,
  principal: string,
  verification: {
    readonly generation: number;
    readonly authorize: Effect.Effect<void, ProtocolError>;
  },
) =>
  runtime.gate.withPermits(1)(
    Effect.gen(function* () {
      yield* verification.authorize;
      const { url, secret } = input.delivery;
      const id = subscriptionId(principal, url);
      yield* checkRegistration(runtime, id);
      if (verification.generation !== runtime.generation) {
        return yield* Effect.fail(
          new ProtocolError(-32012, "Subscription changed during verification"),
        );
      }
      const previous = runtime.state.registration;
      const expiresAt =
        now(runtime) +
        Math.max(60_000, Math.min(input.ttlMs ?? maximumLease, maximumLease));
      yield* save(
        runtime,
        previous === null
          ? initialRegistration({ id, principal, url, secret, expiresAt })
          : refresh(previous, secret, expiresAt, now(runtime)),
      );
      runtime.generation += 1;
      return {
        id,
        refreshBefore: new Date(expiresAt).toISOString(),
        cursor: null,
        truncated: false,
      } as const;
    }).pipe(Effect.uninterruptible),
  );

const subscribe = (
  runtime: WebhookRuntime,
  input: EventSubscribeInput,
  principal: string,
  authorize: Effect.Effect<void, ProtocolError>,
) =>
  Effect.gen(function* () {
    const { url, secret } = input.delivery;
    if (webhookUrl(url) === undefined || !validWebhookSecret(secret)) {
      return yield* Effect.fail(
        new ProtocolError(-32602, "Invalid webhook URL or secret"),
      );
    }
    const id = subscriptionId(principal, url);
    const generation = yield* runtime.gate.withPermits(1)(
      expire(runtime).pipe(
        Effect.zipRight(authorize),
        Effect.zipRight(checkRegistration(runtime, id)),
        Effect.map(() => runtime.generation),
      ),
    );
    yield* verify(runtime, { id, url, secret });
    return yield* activateRegistration(runtime, input, principal, {
      generation,
      authorize,
    });
  });

const enqueue = (
  registration: Registration,
  timestamp: number,
  reminder: boolean,
): Registration => {
  const id = `evt_${randomUUID()}`;
  const body = JSON.stringify({
    eventId: id,
    name: INBOX_PENDING_EVENT,
    timestamp: new Date(timestamp).toISOString(),
    data: { pendingCount: registration.pendingCount },
    cursor: null,
  });
  return {
    ...registration,
    reminders: registration.reminders + (reminder ? 1 : 0),
    outbox: {
      id,
      body,
      sequence: registration.sequence,
      attempts: 0,
      firstAttemptAt: timestamp,
      nextAttemptAt: timestamp,
    },
  };
};

/** A callback suspends only after both the sample size and elapsed-time floor. */
const failedDelivery = (
  registration: Registration,
  occurrence: typeof outboxSchema.Type,
  timestamp: number,
  reason: WebhookFailureReason,
): Registration => {
  const attempts = occurrence.attempts + 1;
  const suspended =
    attempts >= 100 && timestamp - occurrence.firstAttemptAt >= 60 * 60_000;
  return {
    ...registration,
    lastError: reason,
    stalled: suspended ? "callback" : null,
    outbox: {
      ...occurrence,
      attempts,
      nextAttemptAt:
        timestamp + Math.min(reminderDelay, 1000 * 2 ** Math.min(attempts, 9)),
    },
  };
};
const acceptedDelivery = (
  registration: Registration,
  occurrence: NonNullable<Registration["outbox"]>,
  timestamp: number,
  lastError: Registration["lastError"],
): Registration => ({
  ...registration,
  outbox: null,
  lastError,
  reminderAt:
    registration.sequence > occurrence.sequence
      ? timestamp
      : Math.max(registration.reminderAt, timestamp + reminderDelay),
});
/**
 * Late receipts cannot recreate a revoked occurrence or overwrite a refreshed attempt.
 * @param runtime Current subscription state and its serialization gate.
 * @param registration Subscription captured before the callback attempt.
 * @param occurrence Exact outbox attempt whose receipt is being applied.
 * @param error Callback rejection, absent for a successful transport receipt.
 * @returns Completion after applying a receipt that still owns its occurrence.
 */
const completeDelivery = (
  runtime: WebhookRuntime,
  registration: Registration,
  occurrence: NonNullable<Registration["outbox"]>,
  error?: WebhookCallbackError,
) =>
  runtime.gate.withPermits(1)(
    Effect.suspend(() => {
      const current = runtime.state.registration;
      if (
        current === null ||
        current.id !== registration.id ||
        current.outbox !== occurrence
      ) {
        return Effect.void;
      }
      if (error !== undefined && error.discardOccurrence !== true) {
        return save(
          runtime,
          failedDelivery(current, occurrence, now(runtime), error.reason),
        );
      }
      return save(
        runtime,
        acceptedDelivery(
          current,
          occurrence,
          now(runtime),
          error?.reason ?? null,
        ),
      );
    }),
  );
const deliver = (runtime: WebhookRuntime, registration: Registration) =>
  Effect.gen(function* () {
    const occurrence = registration.outbox;
    if (
      occurrence === null ||
      occurrence.nextAttemptAt > now(runtime) ||
      registration.stalled !== null
    ) {
      return;
    }
    yield* post(runtime, {
      url: registration.url,
      secret: registration.secret,
      subscriptionId: registration.id,
      messageId: occurrence.id,
      body: occurrence.body,
      timestamp: now(runtime),
    }).pipe(
      Effect.matchEffect({
        onSuccess: () => completeDelivery(runtime, registration, occurrence),
        onFailure: (error) =>
          completeDelivery(runtime, registration, occurrence, error),
      }),
    );
  });

const progressedRegistration = (registration: Registration): Registration => ({
  ...registration,
  reminders: 0,
  stalled: registration.stalled === "unhandled" ? null : registration.stalled,
});
const updateProgress = (
  registration: Registration,
  summary: InboxSummary,
  timestamp: number,
): Registration => {
  const arrived = summary.newestSequence > registration.sequence;
  const progressed = summary.pendingCount < registration.pendingCount;
  if (
    !arrived &&
    !progressed &&
    summary.pendingCount === registration.pendingCount
  ) {
    return registration;
  }
  const progress = arrived || progressed;
  return {
    ...(progress ? progressedRegistration(registration) : registration),
    sequence: summary.newestSequence,
    pendingCount: summary.pendingCount,
    reminderAt: progressed
      ? timestamp + reminderDelay
      : registration.reminderAt,
    outbox: summary.pendingCount === 0 ? null : registration.outbox,
  };
};
const dueReminder = (
  registration: Registration,
  timestamp: number,
): Registration => {
  if (
    registration.pendingCount === 0 ||
    registration.outbox !== null ||
    registration.stalled !== null ||
    timestamp < registration.reminderAt
  ) {
    return registration;
  }
  return registration.reminders >= maximumReminders
    ? { ...registration, stalled: "unhandled" }
    : enqueue(registration, timestamp, true);
};
const reconcile = (
  registration: Registration,
  summary: InboxSummary,
  timestamp: number,
): Registration => {
  const updated = updateProgress(registration, summary, timestamp);
  const arrived = summary.newestSequence > registration.sequence;
  if (
    arrived &&
    updated.pendingCount > 0 &&
    updated.outbox === null &&
    updated.stalled === null
  ) {
    return enqueue(updated, timestamp, false);
  }
  return dueReminder(updated, timestamp);
};
const observe = (runtime: WebhookRuntime, summary: InboxSummary) =>
  runtime.deliveryGate.withPermits(1)(
    Effect.gen(function* () {
      const registration = yield* runtime.gate.withPermits(1)(
        Effect.gen(function* () {
          yield* expire(runtime);
          const previous = runtime.state.registration;
          if (previous === null) {
            return null;
          }
          const current = reconcile(previous, summary, now(runtime));
          if (current !== previous) {
            yield* save(runtime, current);
          }
          return current;
        }),
      );
      if (registration !== null) {
        yield* deliver(runtime, registration);
      }
    }),
  );

const status = (runtime: WebhookRuntime): WebhookStatus => {
  const registration = runtime.state.registration;
  if (registration === null) {
    return { mode: "none" };
  }
  return {
    mode: "webhook",
    id: registration.id,
    refreshBefore: new Date(registration.expiresAt).toISOString(),
    pendingCount: registration.pendingCount,
    reminders: registration.reminders,
    stalled: registration.stalled,
    lastError: registration.lastError,
  };
};
const resume = (runtime: WebhookRuntime) =>
  Effect.suspend(() => {
    const registration = runtime.state.registration;
    return registration === null
      ? Effect.void
      : save(runtime, {
          ...registration,
          stalled: null,
          reminders: 0,
          reminderAt: 0,
          outbox: resetAttempt(registration, now(runtime)),
        });
  });
const inboxRead = (runtime: WebhookRuntime) =>
  Effect.suspend(() =>
    runtime.state.registration === null
      ? Effect.void
      : save(runtime, {
          ...runtime.state.registration,
          reminderAt: now(runtime) + reminderDelay,
        }),
  );
const unsubscribe = (runtime: WebhookRuntime, url: string, principal: string) =>
  expire(runtime).pipe(
    Effect.zipRight(
      Effect.suspend(() => {
        const registration = runtime.state.registration;
        if (
          registration === null ||
          registration.id !== subscriptionId(principal, url)
        ) {
          return Effect.fail(
            new ProtocolError(-32011, "Subscription not found", {
              kind: "subscription",
            }),
          );
        }
        return retire(runtime);
      }),
    ),
  );

/**
 * Retain exact callback bytes across retries without acknowledging host delivery.
 * State transitions share the push ownership gate; callback I/O runs outside it.
 * @param store Daemon-owned registration and delivery persistence.
 * @param gate Serializes subscription state with native push ownership.
 * @returns Protocol operations using the current Effect HTTP client and clock.
 */
export const makeWebhookEvents = (
  store: EventStore,
  gate: Effect.Semaphore,
): Effect.Effect<HarnessWebhookEvents, ProtocolError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.withTracerDisabledWhen(() => true),
    );
    const clock = yield* Effect.clock;
    const retained = yield* store
      .readEventState()
      .pipe(Effect.mapError(persistenceFailure));
    const state =
      retained === undefined
        ? { registration: null }
        : yield* decodeRuntimeValue(stateSchema, retained).pipe(
            Effect.mapError(persistenceFailure),
          );
    const deliveryGate = yield* Effect.makeSemaphore(1);
    const runtime: WebhookRuntime = {
      store,
      client,
      clock,
      state,
      gate,
      deliveryGate,
      generation: 0,
    };
    const operations: HarnessWebhookEvents = {
      hasActiveSubscription: () => active(runtime),
      subscribe: (input, principal, authorize) =>
        subscribe(runtime, input, principal, authorize ?? Effect.void),
      unsubscribe: (input, principal) =>
        gate.withPermits(1)(
          unsubscribe(runtime, input.delivery.url, principal),
        ),
      observe: (summary) => observe(runtime, summary),
      inboxRead: gate.withPermits(1)(inboxRead(runtime)),
      status: gate.withPermits(1)(
        expire(runtime).pipe(Effect.map(() => status(runtime))),
      ),
      revoke: gate.withPermits(1)(retire(runtime)),
      resume: gate.withPermits(1)(resume(runtime)),
    };
    return operations;
  }).pipe(Effect.withSpan("makeWebhookEvents"));
