/** @file Signed webhook reception behind the same semantic native endpoint as polling. */

import {
  type Client,
  fromJsonSchema,
  type JsonSchemaType,
} from "@modelcontextprotocol/client";
import {
  Deferred,
  Effect,
  JSONSchema,
  Queue,
  Schema,
  type Scope,
  Stream,
  Take,
} from "effect";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { HarnessEndpointOptions, InboundDelivery } from "./capability.js";
import { readEventResultSchema } from "../../delivery/operations.js";
import {
  DeliveryAcknowledgeError,
  ListenError,
} from "../../transport/messaging/errors.js";
import {
  decodeWebhookMessage,
  type ItemEvent,
} from "../event-contract/index.js";
import { INBOX_ITEM_EVENT } from "../mcp/names.js";
import { listenFailure } from "./failures.js";
import {
  acquireCallbackServer,
  type CallbackInput,
  WebhookRequestError,
} from "./webhook-http.js";

type WebhookOptions = Extract<
  NonNullable<HarnessEndpointOptions["delivery"]>,
  { readonly mode: "webhook" }
>;
const grantSchema = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: Schema.Null,
  truncated: Schema.Boolean,
  _meta: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});
const subscriptionOutput = fromJsonSchema<typeof grantSchema.Type>(
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The pinned SDK consumes Effect's derived validator document.
  JSONSchema.make(grantSchema, {
    target: "jsonSchema2020-12",
  }) as JsonSchemaType,
);
const readEventOutput = Schema.decodeUnknown(readEventResultSchema);
const signedHeaders = Schema.decodeUnknown(
  Schema.Struct({
    "webhook-id": Schema.String.pipe(
      Schema.minLength(1),
      Schema.maxLength(512),
    ),
    "webhook-timestamp": Schema.String.pipe(Schema.pattern(/^\d{1,12}$/u)),
    "webhook-signature": Schema.String.pipe(
      Schema.minLength(1),
      Schema.maxLength(2048),
    ),
  }),
);
const rejection = (status: WebhookRequestError["status"]) =>
  new WebhookRequestError({ status });

interface Receiver {
  readonly client: Client;
  readonly options: WebhookOptions;
  readonly secret: Buffer;
  readonly ready: Deferred.Deferred<string, ListenError>;
  readonly queue: Queue.Queue<Take.Take<InboundDelivery, ListenError>>;
  closed: boolean;
}

/**
 * Client owns signatures, verification, reference resolution and lease refresh.
 * Native code accepts an ordinary delivery; its receipt permits HTTP 2xx only
 * after host acceptance. No extra credential is configured: callback signing
 * authority is private, freshly generated subscription state.
 *
 * ```mermaid
 * flowchart TD
 *   Scope[Scoped native consumer] --> Bind[Bind private bounded callback listener]
 *   Bind --> Subscribe[Subscribe with ephemeral signing state]
 *   Subscribe --> Verify[Validate signature and subscription binding]
 *   Verify --> Resolve[Resolve canonical item or immutable reference]
 *   Resolve --> Handoff[Offer delivery to native code]
 *   Handoff --> Receipt{Native accepts?}
 *   Receipt -->|Yes| Success[HTTP success permits daemon acknowledgment]
 *   Receipt -->|No or timeout| Retain[Daemon retains unread work]
 *   Scope --> Close[Fence old closures and release owned subscription]
 * ```
 */
export function webhookMessages(
  client: Client,
  options: WebhookOptions,
): Stream.Stream<InboundDelivery, ListenError> {
  return Stream.unwrapScoped(acquireReceiver(client, options));
}

function acquireReceiver(
  client: Client,
  options: WebhookOptions,
): Effect.Effect<
  Stream.Stream<InboundDelivery, ListenError>,
  ListenError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const url = yield* validateOptions(options);
    const queue =
      yield* Queue.bounded<Take.Take<InboundDelivery, ListenError>>(1);
    const ready = yield* Deferred.make<string, ListenError>();
    const receiver: Receiver = {
      client,
      options,
      queue,
      ready,
      secret: randomBytes(32),
      closed: false,
    };
    yield* Effect.addFinalizer(() => fence(receiver));
    yield* acquireCallbackServer({
      port: options.port,
      path: `${url.pathname}${url.search}`,
      handle: (input) => receive(receiver, input),
    });
    // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- Stream.unwrapScoped owns the returned Scope requirement and releases only a successfully acquired subscription.
    const grant = yield* Effect.acquireRelease(subscribe(receiver), () =>
      close(receiver),
    );
    yield* Deferred.succeed(ready, grant.id);
    yield* options.onReady ?? Effect.void;
    yield* refresh(receiver, grant).pipe(
      Effect.catchAll((error) => Queue.offer(queue, Take.fail(error))),
      Effect.forkScoped,
    );
    return Stream.fromQueue(queue).pipe(Stream.flattenTake);
  }).pipe(Effect.withSpan("webhookMessages"));
}

function validateOptions(options: WebhookOptions) {
  return Effect.suspend(() => {
    if (!validPort(options.port) || !URL.canParse(options.url)) {
      return Effect.fail(new ListenError({ reason: "decode-failed" }));
    }
    const url = new URL(options.url);
    return validCallbackUrl(url)
      ? Effect.succeed(url)
      : Effect.fail(new ListenError({ reason: "decode-failed" }));
  });
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function validCallbackUrl(url: URL): boolean {
  return (
    url.protocol === "https:" && !url.username && !url.password && !url.hash
  );
}

function subscribe(receiver: Receiver) {
  return Effect.tryPromise({
    try: (signal) =>
      receiver.client.request(
        {
          method: "events/subscribe",
          params: {
            name: INBOX_ITEM_EVENT,
            arguments: {},
            cursor: null,
            delivery: {
              mode: "webhook",
              url: receiver.options.url,
              secret: `whsec_${receiver.secret.toString("base64")}`,
            },
          },
        },
        subscriptionOutput,
        { signal },
      ),
    catch: listenFailure,
  });
}

function refresh(
  receiver: Receiver,
  first: typeof grantSchema.Type,
): Effect.Effect<void, ListenError> {
  return Effect.gen(function* () {
    let grant = first;
    while (!receiver.closed) {
      const expiresAt = Date.parse(grant.refreshBefore);
      if (!Number.isFinite(expiresAt)) {
        return yield* Effect.fail(new ListenError({ reason: "decode-failed" }));
      }
      const now = yield* Effect.clockWith((clock) =>
        Effect.succeed(clock.unsafeCurrentTimeMillis()),
      );
      yield* Effect.sleep(Math.max(1000, expiresAt - now - 60_000));
      const next = yield* subscribe(receiver);
      if (next.id !== first.id) {
        return yield* Effect.fail(
          new ListenError({ reason: "consumer-revoked" }),
        );
      }
      grant = next;
    }
  });
}

function receive(receiver: Receiver, input: CallbackInput) {
  return Effect.gen(function* () {
    yield* verify(receiver.secret, input);
    if (receiver.closed || input.signal.aborted) {
      return yield* Effect.fail(rejection(503));
    }
    const message = yield* decodeWebhookMessage(input.body).pipe(
      Effect.catchTag("ParseError", () => Effect.fail(rejection(400))),
    );
    if ("type" in message) {
      return {
        status: 200,
        body: JSON.stringify({ challenge: message.challenge }),
      };
    }
    const id = yield* Deferred.await(receiver.ready).pipe(
      Effect.mapError(() => rejection(503)),
    );
    if (
      input.headers["x-mcp-subscription-id"] !== id ||
      input.headers["webhook-id"] !== message.eventId
    ) {
      return yield* Effect.fail(rejection(403));
    }
    return yield* handoff(receiver, input, message);
  });
}

function verify(secret: Buffer, input: CallbackInput) {
  return Effect.gen(function* () {
    const headers = yield* signedHeaders(input.headers).pipe(
      Effect.catchTag("ParseError", () => Effect.fail(rejection(401))),
    );
    const timestamp = headers["webhook-timestamp"];
    const now = yield* Effect.clockWith((clock) =>
      Effect.succeed(clock.unsafeCurrentTimeMillis()),
    );
    if (Math.abs(now / 1000 - Number(timestamp)) > 300) {
      return yield* Effect.fail(rejection(401));
    }
    const expected = createHmac("sha256", secret)
      .update(`${headers["webhook-id"]}.${timestamp}.${input.body}`)
      .digest();
    const valid = headers["webhook-signature"]
      .split(" ")
      .some((signature) => matchesSignature(signature, expected));
    if (!valid) {
      return yield* Effect.fail(rejection(401));
    }
  });
}

function matchesSignature(signature: string, expected: Buffer): boolean {
  if (!signature.startsWith("v1,")) {
    return false;
  }
  const encoded = signature.slice(3);
  const actual = Buffer.from(encoded, "base64");
  return (
    actual.toString("base64") === encoded &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

function resolveItem(receiver: Receiver, event: ItemEvent) {
  if (event.data.kind === "item") {
    return Effect.succeed(event.data.item);
  }
  const itemKind = event.data.itemKind;
  return Effect.tryPromise({
    try: (signal) =>
      receiver.client.callTool(
        { name: "read_event", arguments: { eventId: event.eventId } },
        { signal },
      ),
    catch: listenFailure,
  }).pipe(
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(new ListenError({ reason: "transport-failed" }))
        : readEventOutput(result.structuredContent).pipe(
            Effect.catchTag("ParseError", () =>
              Effect.fail(new ListenError({ reason: "decode-failed" })),
            ),
          ),
    ),
    Effect.flatMap(({ item }) =>
      item.kind === itemKind
        ? Effect.succeed(item)
        : Effect.fail(new ListenError({ reason: "decode-failed" })),
    ),
  );
}

function handoff(receiver: Receiver, input: CallbackInput, event: ItemEvent) {
  return Effect.gen(function* () {
    const item = yield* resolveItem(receiver, event).pipe(
      Effect.mapError(() => rejection(503)),
    );
    const accepted = yield* Deferred.make<undefined>();
    let active = true;
    const acknowledge = Effect.suspend(() =>
      active && !receiver.closed && !input.signal.aborted
        ? Deferred.succeed(accepted, undefined).pipe(Effect.asVoid)
        : Effect.fail(
            new DeliveryAcknowledgeError({ reason: "consumer-revoked" }),
          ),
    );
    return yield* Queue.offer(
      receiver.queue,
      Take.of({ eventId: event.eventId, item, acknowledge }),
    ).pipe(
      Effect.andThen(Deferred.await(accepted)),
      Effect.as({ status: 200, body: "{}" }),
      Effect.ensuring(
        Effect.sync(() => {
          active = false;
        }),
      ),
    );
  });
}

/** Local fencing stays protected; only the bounded remote release is interruptible during finalization. */
function close(receiver: Receiver) {
  return fence(receiver).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: (signal) =>
          receiver.client.request(
            {
              method: "events/unsubscribe",
              params: {
                name: INBOX_ITEM_EVENT,
                arguments: {},
                delivery: { url: receiver.options.url },
              },
            },
            fromJsonSchema({ type: "object" }),
            { signal },
          ),
        catch: listenFailure,
      }).pipe(
        Effect.interruptible,
        Effect.timeoutOption("5 seconds"),
        Effect.ignore,
      ),
    ),
  );
}

function fence(receiver: Receiver) {
  return Effect.sync(() => {
    receiver.closed = true;
  }).pipe(Effect.andThen(Queue.shutdown(receiver.queue)));
}
