/**
 * @file Collective operations over the post envelope.
 *
 * The daemon holds one `CollectiveOperations` per active identity. It turns
 * each send into the posts its operation certifies and each certified remote
 * post into the item the subscriber receives, or consumes it. Every post an
 * endpoint authors carries its operation as an explicit collective part, so
 * each certified post says which operation it belongs to; a post without a
 * collective part reads as multicast, the operation an omitted `op` names.
 *
 * Gather state lives in daemon memory: an operation open at a daemon restart
 * is lost, and a request whose delivery the member already acknowledged can
 * no longer be answered after one.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant RM as Requester host
 *   participant RE as Requester endpoint
 *   participant ME as Member endpoint
 *   participant MM as Member host
 *   RM->>RE: send gather to, question, deadline, schema
 *   RE->>RE: validate schema, mint id&lt;br>deadline = now + duration
 *   RE->>ME: one request post per member
 *   alt a request post is refused
 *     RE-->>RM: error naming each unreachable member
 *   else every request post accepted
 *     RE-->>RM: operation id
 *   end
 *   ME->>MM: collectiveRequest item
 *   MM->>ME: send collectiveResponse id, action, content
 *   ME->>ME: validate content against the stored schema
 *   ME->>RE: response post in the direct conversation
 *   RE->>RE: consume, validate and record the answer
 *   Note over RE: complete when every member has an outcome&lt;br>or at the deadline
 *   RE->>RM: collectiveResult item
 * ```
 */

import {
  Clock,
  Duration,
  Effect,
  Array as EffectArray,
  Either,
  Exit,
  Fiber,
  Option,
  ParseResult,
  Schema,
  type Scope,
} from "effect";
import { randomBytes } from "node:crypto";
import type { EngineSendInput, EngineSentPost } from "../engine-types.js";
import {
  AgentAddress,
  CollectiveError,
  type CollectiveFailure,
  CollectiveId,
  type CollectiveMemberOutcome,
  type CollectiveOperation,
  type CollectiveResponse,
  type FailureDelivery,
  type InboundItem,
  type InboundMessage,
  MessageAddressInput,
  RequestedSchema,
  SendError,
  type SendInput,
  type SendResult,
} from "../../contract.js";
import { outcomeOfResponse, validateAnswer } from "./validation.js";
import {
  type CollectiveValue,
  encodeCollectiveContent,
  FormModeSchema,
  readCollectiveValue,
  withoutCollectivePart,
} from "./wire.js";

type PostContent = InboundMessage["content"];

type GatherOperation = Extract<CollectiveOperation, { readonly op: "gather" }>;

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

type ResponseValue = Extract<CollectiveValue, { readonly kind: "response" }>;

/**
 * How long a gather's send waits for its request posts before returning. A
 * request still uncertified then is left running: its member answers or is
 * reported as no-answer at the deadline. The bound stays under the MCP SDK's
 * request timeout so a waiting host receives the result rather than a
 * transport timeout.
 */
const REQUEST_SEND_WAIT = Duration.seconds(20);

/** What the collective layer needs from the daemon around it. */
export interface CollectivePorts {
  /** The local agent: a group gather asks every member but this one. */
  readonly self: AgentAddress;
  /** Certify one post and complete once it is stored locally. */
  readonly sendPost: (
    input: EngineSendInput,
  ) => Effect.Effect<EngineSentPost, SendError>;
  /** Queue an item the layer emits itself: a result or a failure. */
  readonly emit: (item: InboundItem) => Effect.Effect<void>;
  /** Owns deadline timers and request sends that outlive their send call. */
  readonly scope: Scope.Scope;
  /** Overrides `REQUEST_SEND_WAIT`; tests bound the wait. */
  readonly requestSendWait?: Duration.Duration;
}

/** One completed send: the posts certified by its return, and a collective id. */
interface CollectiveSendOutcome extends SendResult {
  readonly postIds: ReadonlyArray<EngineSentPost["postId"]>;
}

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /**
   * Perform one send. A gather completes once every request post is accepted
   * and fails naming each member whose post was refused; a response is
   * validated against its request's schema and addressed to the requester.
   */
  readonly send: (
    input: SendInput,
    failureDelivery: FailureDelivery,
  ) => Effect.Effect<CollectiveSendOutcome, SendError | CollectiveError>;
  /**
   * Classify one certified remote post. Answers are recorded and consumed,
   * every other protocol post is consumed, and each remaining post becomes
   * one item. Classifying a post again yields the same result, so the daemon
   * may run it on every pass over pending deliveries.
   */
  readonly classify: (
    message: InboundMessage,
  ) => Effect.Effect<Option.Option<InboundItem>>;
}

/** A gather this endpoint started that has not completed. */
interface OpenGather {
  readonly to: MessageAddressInput;
  readonly question: string;
  readonly members: readonly [AgentAddress, ...AgentAddress[]];
  readonly requestedSchema: FormModeSchema;
  readonly outcomes: Map<AgentAddress, CollectiveMemberOutcome>;
}

/**
 * A request this endpoint received. `sending` holds the one answer in flight,
 * so a member answers at most once; a refused answer reopens the request.
 */
interface ReceivedRequest {
  readonly from: AgentAddress;
  readonly requestedSchema: FormModeSchema;
  readonly deadlineAt: number;
  state: "open" | "sending" | "answered";
}

interface CollectiveState {
  readonly ports: CollectivePorts;
  readonly gathers: Map<CollectiveId, OpenGather>;
  readonly requests: Map<CollectiveId, ReceivedRequest>;
}

const decodeCollectiveId = Schema.decodeUnknownSync(CollectiveId);
const decodeAgentAddress = Schema.decodeUnknownOption(AgentAddress);
const decodeAddressInput = Schema.decodeUnknownOption(MessageAddressInput);
const decodeRequestedSchema = Schema.decodeUnknownOption(RequestedSchema);

const mintCollectiveId = Effect.sync(() =>
  decodeCollectiveId(`col_${randomBytes(32).toString("base64url")}`),
);

const contentInvalid = () => new SendError({ reason: "content-invalid" });

const collectiveFailure = (id: CollectiveId, failure: CollectiveFailure) =>
  new CollectiveError({ id, failure });

/**
 * Build the collective layer for one active identity.
 * @param ports The daemon's post sending, item queue, scope and identity.
 * @returns Send and classification over state held in daemon memory.
 */
export const makeCollectiveOperations = (
  ports: CollectivePorts,
): CollectiveOperations => {
  const state: CollectiveState = {
    ports,
    gathers: new Map(),
    requests: new Map(),
  };
  return {
    send: (input, failureDelivery) =>
      "collectiveResponse" in input
        ? reportFailure(
            state,
            failureDelivery,
            respond(state, input.collectiveResponse),
          )
        : sendOperation(state, input, failureDelivery),
    classify: (message) => classify(state, message),
  };
};

function sendOperation(
  state: CollectiveState,
  input: Extract<SendInput, { readonly to: MessageAddressInput }>,
  failureDelivery: FailureDelivery,
): Effect.Effect<CollectiveSendOutcome, SendError | CollectiveError> {
  const operation = input.collective ?? {};
  switch (operation.op) {
    case undefined:
    case "multicast":
      return multicast(state, input.to, input.text);
    case "gather":
      return reportFailure(
        state,
        failureDelivery,
        gather(state, input.to, input.text, operation),
      );
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function multicast(
  state: CollectiveState,
  to: MessageAddressInput,
  text: string,
): Effect.Effect<CollectiveSendOutcome, SendError> {
  return encodeCollectiveContent(
    { kind: "operation", op: "multicast" },
    text,
  ).pipe(
    Effect.mapError(contentInvalid),
    Effect.flatMap((content) => state.ports.sendPost({ to, content })),
    Effect.map((post) => ({ postIds: [post.postId] })),
  );
}

/**
 * A refused collective send, with the address its failure item routes to.
 * The address is the operation's own, or the requester's for a response.
 */
interface RefusedSend<E> {
  readonly id: CollectiveId;
  readonly to: MessageAddressInput;
  readonly error: E;
}

/**
 * Deliver a refused collective send's error where the host wants it. With
 * `inbound` the send completes, naming the operation, and the error arrives
 * as an `operationFailed` item carrying the same text.
 */
function reportFailure(
  state: CollectiveState,
  failureDelivery: FailureDelivery,
  send: Effect.Effect<
    CollectiveSendOutcome,
    RefusedSend<SendError | CollectiveError>
  >,
): Effect.Effect<CollectiveSendOutcome, SendError | CollectiveError> {
  return send.pipe(
    Effect.catchAll((refused) => {
      switch (failureDelivery) {
        case "result":
          return Effect.fail(refused.error);
        case "inbound":
          return state.ports
            .emit({
              kind: "operationFailed",
              id: refused.id,
              to: refused.to,
              error: refused.error.message,
            })
            .pipe(Effect.as({ operationId: refused.id, postIds: [] }));
        default: {
          const exhaustive: never = failureDelivery;
          return exhaustive;
        }
      }
    }),
  );
}

function refusedAs<E>(id: CollectiveId, to: MessageAddressInput) {
  return (error: E): RefusedSend<E> => ({ id, to, error });
}

/**
 * The members a gather asks: the one agent of an `agent:` address, or every
 * named member of a `group:` address but the requester, each once.
 */
function gatherMembers(
  to: MessageAddressInput,
  self: AgentAddress,
): readonly AgentAddress[] {
  if (to.startsWith("agent:")) {
    return Option.toArray(decodeAgentAddress(to));
  }
  const names = to.slice("group:".length).split(",");
  return EffectArray.dedupe(
    names.flatMap((name) =>
      Option.toArray(decodeAgentAddress(`agent:${name}`)),
    ),
  ).filter((member) => member !== self);
}

/** Order names by UTF-16 code unit, which is ASCII order for agent names. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The address a gather's result and failure name: an `agent:` address as
 * given, or a group's names with the requester added, each once and sorted,
 * which is the group conversation's own address.
 */
function collectiveAddress(
  to: MessageAddressInput,
  self: AgentAddress,
): MessageAddressInput {
  if (to.startsWith("agent:")) {
    return to;
  }
  const names = new Set([
    ...to.slice("group:".length).split(","),
    self.slice("agent:".length),
  ]);
  return decodeAddressInput(
    `group:${[...names].sort(compareCodeUnits).join(",")}`,
  ).pipe(Option.getOrElse(() => to));
}

/**
 * A validated gather ready to fan out: its open state, the request content
 * every member receives, and the milliseconds left until its deadline.
 */
interface PreparedGather {
  readonly id: CollectiveId;
  readonly open: OpenGather;
  readonly content: PostContent;
  readonly untilDeadline: number;
}

/** Check a gather's schema against the MCP form-mode grammar. */
function formModeSchema(
  id: CollectiveId,
  requestedSchema: GatherOperation["requestedSchema"],
): Effect.Effect<FormModeSchema, CollectiveError> {
  return Schema.decodeUnknown(FormModeSchema)(requestedSchema).pipe(
    Effect.mapError((error) =>
      collectiveFailure(id, {
        kind: "schema-invalid",
        detail: ParseResult.TreeFormatter.formatErrorSync(error),
      }),
    ),
  );
}

/**
 * Validate a gather before any post: mint its id, check its schema against
 * the form-mode grammar, name its members, fix its absolute deadline, and
 * build the request content within the content limit.
 */
function prepareGather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: GatherOperation,
): Effect.Effect<PreparedGather, RefusedSend<SendError | CollectiveError>> {
  return Effect.gen(function* () {
    const id = yield* mintCollectiveId;
    const to = collectiveAddress(requestedTo, state.ports.self);
    const refused = refusedAs<SendError | CollectiveError>(id, to);
    const requestedSchema = yield* formModeSchema(
      id,
      operation.requestedSchema,
    ).pipe(Effect.mapError(refused));
    const [first, ...rest] = gatherMembers(to, state.ports.self);
    if (first === undefined) {
      return yield* Effect.fail(
        refused(new SendError({ reason: "membership-invalid" })),
      );
    }
    const now = yield* Clock.currentTimeMillis;
    const untilDeadline = Duration.toMillis(
      Duration.seconds(operation.deadline),
    );
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: "gather",
        id,
        deadlineAt: now + untilDeadline,
        requestedSchema,
      },
      question,
    ).pipe(Effect.mapError(() => refused(contentInvalid())));
    const open: OpenGather = {
      to,
      question,
      members: [first, ...rest],
      requestedSchema,
      outcomes: new Map(),
    };
    return { id, open, content, untilDeadline };
  });
}

/**
 * Open the gather so answers can be recorded while its requests are still
 * being sent, fan the requests out, and schedule its completion at the
 * deadline.
 */
function gather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: GatherOperation,
): Effect.Effect<
  CollectiveSendOutcome,
  RefusedSend<SendError | CollectiveError>
> {
  return Effect.gen(function* () {
    const prepared = yield* prepareGather(
      state,
      requestedTo,
      question,
      operation,
    );
    yield* Effect.sync(() => {
      state.gathers.set(prepared.id, prepared.open);
    });
    const postIds = yield* sendRequests(state, prepared).pipe(
      Effect.mapError(refusedAs(prepared.id, prepared.open.to)),
    );
    yield* Effect.sleep(Duration.millis(prepared.untilDeadline)).pipe(
      Effect.zipRight(completeGather(state, prepared.id)),
      Effect.forkIn(state.ports.scope),
    );
    return { operationId: prepared.id, postIds };
  });
}

/** A member whose request post was refused, and why. */
type RequestRefusal = Readonly<{
  member: AgentAddress;
  reason: SendError["reason"];
}>;

/** A request post in flight, resolving to the member's refusal, if any. */
type RequestSend = Fiber.RuntimeFiber<
  Either.Either<EngineSentPost, RequestRefusal>
>;

/**
 * Send one request post per member and wait for them, never past the
 * deadline. Any refusal abandons the gather and names every refused member;
 * a post still pending when the wait ends is left running.
 */
function sendRequests(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<ReadonlyArray<EngineSentPost["postId"]>, CollectiveError> {
  return Effect.gen(function* () {
    const sends = yield* Effect.forEach(
      prepared.open.members,
      (member): Effect.Effect<RequestSend> =>
        state.ports.sendPost({ to: member, content: prepared.content }).pipe(
          Effect.mapError((error) => ({ member, reason: error.reason })),
          Effect.either,
          Effect.forkIn(state.ports.scope),
        ),
      { concurrency: 1 },
    );
    yield* Fiber.awaitAll(sends).pipe(
      Effect.timeoutOption(
        Duration.min(
          state.ports.requestSendWait ?? REQUEST_SEND_WAIT,
          Duration.millis(prepared.untilDeadline),
        ),
      ),
    );
    const results = yield* settledSends(sends);
    const [refusal, ...refusals] = results.flatMap((result) =>
      Option.toArray(Either.getLeft(result)),
    );
    if (refusal !== undefined) {
      yield* abandonGather(state, prepared.id, sends);
      return yield* Effect.fail(
        collectiveFailure(prepared.id, {
          kind: "members-unreachable",
          members: [refusal, ...refusals],
        }),
      );
    }
    return results.flatMap((result) =>
      Option.toArray(Either.getRight(result)).map((post) => post.postId),
    );
  });
}

/** The request sends that have finished, each with its post or refusal. */
function settledSends(
  sends: readonly RequestSend[],
): Effect.Effect<ReadonlyArray<Either.Either<EngineSentPost, RequestRefusal>>> {
  return Effect.forEach(sends, (send) => Fiber.poll(send), {
    concurrency: 1,
  }).pipe(
    Effect.map((polls) =>
      polls.flatMap((poll) =>
        Option.toArray(
          Option.flatMap(poll, (exit) =>
            Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
          ),
        ),
      ),
    ),
  );
}

function abandonGather(
  state: CollectiveState,
  id: CollectiveId,
  sends: readonly RequestSend[],
): Effect.Effect<void> {
  return Effect.forEach(sends, (send) => Fiber.interruptFork(send), {
    concurrency: 1,
    discard: true,
  }).pipe(
    Effect.zipRight(
      Effect.sync(() => {
        state.gathers.delete(id);
      }),
    ),
  );
}

/**
 * Close a gather and emit its result: each member's recorded outcome, or
 * no-answer. A gather completes once; a later call does nothing.
 */
function completeGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    if (open === undefined) {
      return Effect.void;
    }
    state.gathers.delete(id);
    const outcome = (member: AgentAddress) => ({
      member,
      outcome: open.outcomes.get(member) ?? { kind: "no-answer" as const },
    });
    const [first, ...rest] = open.members;
    return state.ports.emit({
      kind: "collectiveResult",
      id,
      to: open.to,
      question: open.question,
      outcomes: [outcome(first), ...rest.map(outcome)],
    });
  });
}

function respond(
  state: CollectiveState,
  response: CollectiveResponse,
): Effect.Effect<
  CollectiveSendOutcome,
  RefusedSend<SendError | CollectiveError>
> {
  return Effect.gen(function* () {
    const { id } = response;
    const now = yield* Clock.currentTimeMillis;
    const request = yield* openRequest(state, id, now);
    const refused = refusedAs<SendError | CollectiveError>(id, request.from);
    const content = yield* responseContent(request, response).pipe(
      Effect.mapError(refused),
    );
    yield* claimRequest(id, request).pipe(Effect.mapError(refused));
    const post = yield* state.ports
      .sendPost({ to: request.from, content })
      .pipe(
        Effect.tapBoth({
          onFailure: () => setRequestState(request, "open"),
          onSuccess: () => setRequestState(request, "answered"),
        }),
        Effect.onInterrupt(() => setRequestState(request, "open")),
        Effect.mapError(refused),
      );
    return { operationId: id, postIds: [post.postId] };
  });
}

/**
 * The received request a response answers, refused when this endpoint never
 * received it, it was already answered, or its deadline has passed. A refusal
 * for an unknown request is addressed to the local agent, since no requester
 * is known.
 */
function openRequest(
  state: CollectiveState,
  id: CollectiveId,
  now: number,
): Effect.Effect<ReceivedRequest, RefusedSend<CollectiveError>> {
  const request = state.requests.get(id);
  if (request === undefined) {
    return Effect.fail({
      id,
      to: state.ports.self,
      error: collectiveFailure(id, { kind: "request-unknown" }),
    });
  }
  const unavailable = requestUnavailable(request, now);
  return unavailable === undefined
    ? Effect.succeed(request)
    : Effect.fail({
        id,
        to: request.from,
        error: collectiveFailure(id, { kind: unavailable }),
      });
}

function requestUnavailable(
  request: ReceivedRequest,
  now: number,
): "request-answered" | "request-expired" | undefined {
  if (request.state !== "open") {
    return "request-answered";
  }
  return now >= request.deadlineAt ? "request-expired" : undefined;
}

/**
 * Validate an `accept` answer against the request's stored schema and build
 * the response post's content, which carries no text.
 */
function responseContent(
  request: ReceivedRequest,
  response: CollectiveResponse,
): Effect.Effect<PostContent, SendError | CollectiveError> {
  const validated =
    response.action === "accept"
      ? validateAnswer(request.requestedSchema, response.content).pipe(
          Effect.mapError((error) =>
            collectiveFailure(response.id, {
              kind: "answer-invalid",
              fields: error.failures,
            }),
          ),
        )
      : Effect.void;
  return validated.pipe(
    Effect.zipRight(
      encodeCollectiveContent({ kind: "response", ...response }).pipe(
        Effect.mapError(contentInvalid),
      ),
    ),
  );
}

/**
 * Hold the request's one answer. The check and the claim run without a yield
 * between them, so of two concurrent answers only one is sent.
 */
function claimRequest(
  id: CollectiveId,
  request: ReceivedRequest,
): Effect.Effect<void, CollectiveError> {
  return Effect.suspend(() => {
    if (request.state !== "open") {
      return Effect.fail(collectiveFailure(id, { kind: "request-answered" }));
    }
    request.state = "sending";
    return Effect.void;
  });
}

function setRequestState(
  request: ReceivedRequest,
  next: ReceivedRequest["state"],
): Effect.Effect<void> {
  return Effect.sync(() => {
    request.state = next;
  });
}

function classify(
  state: CollectiveState,
  message: InboundMessage,
): Effect.Effect<Option.Option<InboundItem>> {
  return readCollectiveValue(message.content).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            Option.some<InboundItem>({ kind: "multicast", message }),
          ),
        onSome: (value) => collectiveItem(state, message, value),
      }),
    ),
    Effect.catchTag("CollectivePartInvalidError", (error) =>
      Effect.logWarning(
        `consumed post ${message.postId} from ${message.sender}: its collective part is ${error.reason}`,
      ).pipe(Effect.as(Option.none())),
    ),
  );
}

function collectiveItem(
  state: CollectiveState,
  message: InboundMessage,
  value: CollectiveValue,
): Effect.Effect<Option.Option<InboundItem>> {
  switch (value.kind) {
    case "operation":
      return operationItem(state, message, value);
    case "response":
      return recordAnswer(state, message, value).pipe(Effect.as(Option.none()));
    case "close":
      return Effect.succeed(Option.none());
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function operationItem(
  state: CollectiveState,
  message: InboundMessage,
  value: Extract<CollectiveValue, { readonly kind: "operation" }>,
): Effect.Effect<Option.Option<InboundItem>> {
  switch (value.op) {
    case "multicast":
      return Effect.succeed(
        multicastItem(message, withoutCollectivePart(message.content)),
      );
    case "gather":
      return requestItem(state, message, value);
    case "all_gather":
      return Effect.succeed(Option.none());
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function multicastItem(
  message: InboundMessage,
  content: ReadonlyArray<PostContent[number]>,
): Option.Option<InboundItem> {
  return EffectArray.isNonEmptyReadonlyArray(content)
    ? Option.some({ kind: "multicast", message: { ...message, content } })
    : Option.none();
}

function questionText(content: PostContent): string {
  return withoutCollectivePart(content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Record a received gather request and present it as an item. A request
 * reaches its member in their direct conversation; one in a group, one past
 * its deadline, or one reusing another requester's id is consumed.
 */
function requestItem(
  state: CollectiveState,
  message: InboundMessage,
  value: CollectingValue,
): Effect.Effect<Option.Option<InboundItem>> {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      if (message.kind !== "direct" || now >= value.deadlineAt) {
        return Option.none();
      }
      const known = state.requests.get(value.id);
      if (known !== undefined && known.from !== message.sender) {
        return Option.none();
      }
      if (known === undefined) {
        forgetExpiredRequests(state, now);
        state.requests.set(value.id, {
          from: message.sender,
          requestedSchema: value.requestedSchema,
          deadlineAt: value.deadlineAt,
          state: "open",
        });
      }
      return decodeRequestedSchema(value.requestedSchema).pipe(
        Option.map(
          (requestedSchema): InboundItem => ({
            kind: "collectiveRequest",
            id: value.id,
            postId: message.postId,
            from: message.sender,
            question: questionText(message.content),
            requestedSchema,
            deadlineAt: value.deadlineAt,
          }),
        ),
      );
    }),
  );
}

function forgetExpiredRequests(state: CollectiveState, now: number): void {
  for (const [id, request] of state.requests) {
    if (now >= request.deadlineAt) {
      state.requests.delete(id);
    }
  }
}

/**
 * Record a member's answer to an open gather. Only the member's direct post
 * counts, and only its first; an answer to a completed or unknown gather
 * changes nothing. The last outstanding answer completes the gather.
 */
function recordAnswer(
  state: CollectiveState,
  message: InboundMessage,
  value: ResponseValue,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const open = state.gathers.get(value.id);
    if (
      open === undefined ||
      message.kind !== "direct" ||
      !open.members.includes(message.sender) ||
      open.outcomes.has(message.sender)
    ) {
      return Effect.void;
    }
    return outcomeOfResponse(open.requestedSchema, value).pipe(
      Effect.flatMap((outcome) => {
        open.outcomes.set(message.sender, outcome);
        return open.outcomes.size === open.members.length
          ? completeGather(state, value.id)
          : Effect.void;
      }),
    );
  });
}
