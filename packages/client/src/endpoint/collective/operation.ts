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
 * Collective state lives in daemon memory: an operation open at a daemon
 * restart is lost, and a request whose delivery the member already
 * acknowledged can no longer be answered after one.
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
 *
 * An all_gather asks a group in its own conversation. Every member endpoint
 * consumes the answers it sees there, so no model sees a peer's answer before
 * the close, and builds its result from exactly the answers the requester's
 * close lists.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant RM as Requester host
 *   participant RE as Requester endpoint
 *   participant ME as Member endpoints
 *   participant MM as Member hosts
 *   RM->>RE: send all_gather to group, question, deadline, schema
 *   RE->>ME: one request post to the group
 *   alt the group post is refused or not certified in time
 *     RE-->>RM: error naming each unreachable member
 *   else request post certified
 *     RE-->>RM: operation id
 *   end
 *   ME->>MM: collectiveRequest item
 *   MM->>ME: send collectiveResponse id, action, content
 *   ME->>ME: validate content against the stored schema
 *   ME->>RE: response post to the group
 *   ME->>ME: peer response posts, consumed and recorded by record hash
 *   Note over RE: complete when every member has an outcome&lt;br>or at the deadline
 *   RE->>ME: close post listing the counted answers' record hashes
 *   RE->>RM: collectiveResult item once the close is certified
 *   ME->>ME: build the result from exactly the listed answers
 *   ME->>MM: collectiveResult item, the same outcomes
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
import type { RecordHash } from "../representation.js";
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
  type PostId,
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

type CollectingOperation = Extract<
  CollectiveOperation,
  { readonly deadline: number }
>;

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

type ResponseValue = Extract<CollectiveValue, { readonly kind: "response" }>;

type CloseValue = Extract<CollectiveValue, { readonly kind: "close" }>;

/**
 * How long a collecting operation's send waits for its request posts before
 * returning. A gather's request still uncertified then is left running: its
 * member answers or is reported as no-answer at the deadline. An all_gather's
 * one group post must be certified by then, or the all_gather cannot start:
 * a cold group's GENESIS needs every member. The bound stays under the MCP
 * SDK's request timeout so a waiting host receives the result rather than a
 * transport timeout.
 */
const REQUEST_SEND_WAIT = Duration.seconds(20);

/**
 * How long past its deadline a member keeps an all_gather request while it
 * waits for the requester's close. The requester closes at the deadline at
 * the latest, so the close normally follows within seconds; the bound frees
 * the request of a requester that never closes.
 */
const CLOSE_WAIT = Duration.hours(1);

/** What the collective layer needs from the daemon around it. */
export interface CollectivePorts {
  /** The local agent: a group gather or all_gather asks every member but this one. */
  readonly self: AgentAddress;
  /**
   * Resolve one member's Registry card without sending. A refused all_gather
   * group post names only the members that fail this lookup.
   */
  readonly lookupMember: (
    member: AgentAddress,
  ) => Effect.Effect<void, SendError>;
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

/** One certified remote post with the hash of its certified record. */
interface CertifiedPost {
  readonly message: InboundMessage;
  readonly recordHash: RecordHash;
}

/** One completed send: the posts certified by its return, and a collective id. */
interface CollectiveSendOutcome extends SendResult {
  readonly postIds: ReadonlyArray<EngineSentPost["postId"]>;
}

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /**
   * Perform one send. A gather completes once every request post is accepted
   * and fails naming each member whose post was refused; an all_gather
   * completes once its group post is certified. A response is validated
   * against its request's schema and addressed to the request's conversation.
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
    post: CertifiedPost,
  ) => Effect.Effect<Option.Option<InboundItem>>;
}

type Members = readonly [AgentAddress, ...AgentAddress[]];

/**
 * A gather or all_gather this endpoint started that has not completed.
 * `answerHashes` holds the certified record of each counted answer, which an
 * all_gather's close lists.
 */
interface OpenGather {
  readonly op: CollectingOperation["op"];
  readonly to: MessageAddressInput;
  readonly question: string;
  readonly members: Members;
  readonly requestedSchema: FormModeSchema;
  readonly outcomes: Map<AgentAddress, CollectiveMemberOutcome>;
  readonly answerHashes: Map<AgentAddress, RecordHash>;
}

/** One answer certified in an all_gather's group conversation. */
interface CertifiedAnswer {
  readonly member: AgentAddress;
  readonly response: ResponseValue;
}

/** A close whose listed answers wait for this member's own answer to certify. */
interface HeldClose {
  readonly postId: PostId;
  readonly included: readonly RecordHash[];
}

/**
 * What a member of an all_gather keeps until the close: every answer
 * certified in the group conversation, by record hash, its own included.
 */
interface SharedAnswers {
  readonly question: string;
  readonly members: Members;
  readonly answers: Map<RecordHash, CertifiedAnswer>;
  heldClose?: HeldClose;
}

/**
 * A request this endpoint received. `to` is the conversation it arrived in
 * and every answer goes to. `sending` holds the one answer in flight, so a
 * member answers at most once; a refused answer reopens the request. An
 * all_gather request carries `shared` and becomes `closed` at its close.
 */
interface ReceivedRequest {
  readonly from: AgentAddress;
  readonly to: MessageAddressInput;
  readonly requestedSchema: FormModeSchema;
  readonly deadlineAt: number;
  state: "open" | "sending" | "answered" | "closed";
  readonly shared?: SharedAnswers;
}

/** An all_gather request a member holds, under its id. */
interface AskedAllGather {
  readonly id: CollectiveId;
  readonly request: ReceivedRequest;
  readonly shared: SharedAnswers;
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
    case "all_gather":
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
 * The address a collecting operation's result and failure name: an `agent:`
 * address as given, or a group's names with the requester added, each once and sorted,
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

/** Check a collecting operation's schema against the MCP form-mode grammar. */
function formModeSchema(
  id: CollectiveId,
  requestedSchema: CollectingOperation["requestedSchema"],
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
 * Validate a gather or all_gather before any post: mint its id, check its
 * schema against the form-mode grammar, name its members, fix its absolute
 * deadline, and build the request content within the content limit. An
 * all_gather asks a group in its conversation, so it needs a `group:`
 * address; the engine applies the group size rule when it sends.
 */
function prepareGather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: CollectingOperation,
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
    if (
      first === undefined ||
      (operation.op === "all_gather" && !to.startsWith("group:"))
    ) {
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
        op: operation.op,
        id,
        deadlineAt: now + untilDeadline,
        requestedSchema,
      },
      question,
    ).pipe(Effect.mapError(() => refused(contentInvalid())));
    const open: OpenGather = {
      op: operation.op,
      to,
      question,
      members: [first, ...rest],
      requestedSchema,
      outcomes: new Map(),
      answerHashes: new Map(),
    };
    return { id, open, content, untilDeadline };
  });
}

/**
 * Open the operation so answers can be recorded while its requests are still
 * being sent, send them, and schedule its completion at the deadline.
 */
function gather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: CollectingOperation,
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
    const requests =
      prepared.open.op === "gather"
        ? sendRequests(state, prepared)
        : sendGroupRequest(state, prepared);
    const postIds = yield* requests.pipe(
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
      Effect.timeoutOption(requestWait(state, prepared)),
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

/**
 * Send an all_gather's one request post to the group and wait for it, never
 * past the deadline. A refused post, or one still uncertified when the wait
 * ends, abandons the all_gather: the group's GENESIS needs every member.
 */
function sendGroupRequest(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<ReadonlyArray<EngineSentPost["postId"]>, CollectiveError> {
  return state.ports
    .sendPost({ to: prepared.open.to, content: prepared.content })
    .pipe(
      Effect.timeoutFail({
        duration: requestWait(state, prepared),
        onTimeout: () => new SendError({ reason: "certification-unavailable" }),
      }),
      Effect.map((post) => [post.postId]),
      Effect.catchAll((error) =>
        unreachableMembers(state, prepared.open.members, error.reason).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              state.gathers.delete(prepared.id);
            }),
          ),
          Effect.flatMap((members) =>
            Effect.fail(
              collectiveFailure(prepared.id, {
                kind: "members-unreachable",
                members,
              }),
            ),
          ),
        ),
      ),
    );
}

/**
 * The members to name for a refused group post. A group post succeeds or
 * fails as a whole, so each member is looked up on its own: the members whose
 * lookup fails are named with their own reason, and when every lookup
 * succeeds each member is named with the group post's reason.
 */
function unreachableMembers(
  state: CollectiveState,
  members: Members,
  groupReason: SendError["reason"],
): Effect.Effect<readonly [RequestRefusal, ...RequestRefusal[]]> {
  return Effect.forEach(
    members,
    (member) =>
      state.ports.lookupMember(member).pipe(
        Effect.flip,
        Effect.map(
          (error): RequestRefusal => ({ member, reason: error.reason }),
        ),
        Effect.option,
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((lookups) => {
      const [first, ...rest] = lookups.flatMap((lookup) =>
        Option.toArray(lookup),
      );
      if (first !== undefined) {
        return [first, ...rest];
      }
      const [member, ...others] = members;
      return [
        { member, reason: groupReason },
        ...others.map((other) => ({ member: other, reason: groupReason })),
      ];
    }),
  );
}

/** How long a send waits for request posts: the bound, never past the deadline. */
function requestWait(
  state: CollectiveState,
  prepared: PreparedGather,
): Duration.Duration {
  return Duration.min(
    state.ports.requestSendWait ?? REQUEST_SEND_WAIT,
    Duration.millis(prepared.untilDeadline),
  );
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

type CollectiveResultItem = Extract<
  InboundItem,
  { readonly kind: "collectiveResult" }
>;

/** Each member's outcome in member order; a member without one had no answer. */
function memberOutcomes(
  members: Members,
  outcomes: ReadonlyMap<AgentAddress, CollectiveMemberOutcome>,
): CollectiveResultItem["outcomes"] {
  const outcome = (member: AgentAddress) => ({
    member,
    outcome: outcomes.get(member) ?? { kind: "no-answer" as const },
  });
  const [first, ...rest] = members;
  return [outcome(first), ...rest.map(outcome)];
}

/**
 * Complete an operation this endpoint started. A gather emits its result
 * now; an all_gather first posts its close, off the calling fiber because
 * completion can run inside a publication pass that certification waits on.
 * An operation completes once; a later call does nothing.
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
    const result: CollectiveResultItem = {
      kind: "collectiveResult",
      id,
      to: open.to,
      question: open.question,
      outcomes: memberOutcomes(open.members, open.outcomes),
    };
    switch (open.op) {
      case "gather":
        return state.ports.emit(result);
      case "all_gather":
        return closeAllGather(state, open, result).pipe(
          Effect.forkIn(state.ports.scope),
          Effect.asVoid,
        );
      default: {
        const exhaustive: never = open.op;
        return exhaustive;
      }
    }
  });
}

/**
 * Post an all_gather's close, listing the certified record of every answer
 * its result counts, and emit the result once the close is certified, naming
 * the close post. A close that cannot be certified ends the operation as an
 * `operationFailed` item, since members then have no result to agree on.
 */
function closeAllGather(
  state: CollectiveState,
  open: OpenGather,
  result: CollectiveResultItem,
): Effect.Effect<void> {
  const included = open.members.flatMap((member) =>
    Option.toArray(Option.fromNullable(open.answerHashes.get(member))),
  );
  return encodeCollectiveContent({
    kind: "close",
    id: result.id,
    included,
  }).pipe(
    Effect.mapError(contentInvalid),
    Effect.flatMap((content) => state.ports.sendPost({ to: open.to, content })),
    Effect.matchEffect({
      onFailure: (error) =>
        state.ports.emit({
          kind: "operationFailed",
          id: result.id,
          to: open.to,
          error: `collective ${result.id} failed: its close was not certified (${error.reason})`,
        }),
      onSuccess: (post) =>
        state.ports.emit({ ...result, closePostId: post.postId }),
    }),
  );
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
    const refused = refusedAs<SendError | CollectiveError>(id, request.to);
    const value: ResponseValue = { kind: "response", ...response };
    const content = yield* responseContent(request, value).pipe(
      Effect.mapError(refused),
    );
    yield* claimRequest(id, request).pipe(Effect.mapError(refused));
    const post = yield* state.ports.sendPost({ to: request.to, content }).pipe(
      Effect.tapBoth({
        onFailure: () => answerRefused(state, id, request),
        onSuccess: (sent) =>
          answerCertified(state, id, request, {
            recordHash: sent.recordHash,
            answer: { member: state.ports.self, response: value },
          }),
      }),
      Effect.onInterrupt(() => answerRefused(state, id, request)),
      Effect.mapError(refused),
    );
    return { operationId: id, postIds: [post.postId] };
  });
}

/**
 * The received request a response answers, refused when this endpoint never
 * received it, it was already answered, or its deadline or close has passed.
 * A refusal for an unknown request is addressed to the local agent, since no
 * requester is known.
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
        to: request.to,
        error: collectiveFailure(id, { kind: unavailable }),
      });
}

function requestUnavailable(
  request: ReceivedRequest,
  now: number,
): "request-answered" | "request-expired" | undefined {
  switch (request.state) {
    case "open":
      return now >= request.deadlineAt ? "request-expired" : undefined;
    case "sending":
    case "answered":
      return "request-answered";
    case "closed":
      return "request-expired";
    default: {
      const exhaustive: never = request.state;
      return exhaustive;
    }
  }
}

/**
 * Validate an `accept` answer against the request's stored schema and build
 * the response post's content, which carries no text.
 */
function responseContent(
  request: ReceivedRequest,
  response: ResponseValue,
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
      encodeCollectiveContent(response).pipe(Effect.mapError(contentInvalid)),
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

/**
 * Mark a request answered. A member's own answer never arrives inbound, so
 * an all_gather member records it here by its certified record, and applies
 * a close that was waiting for it.
 */
function answerCertified(
  state: CollectiveState,
  id: CollectiveId,
  request: ReceivedRequest,
  certified: Readonly<{ recordHash: RecordHash; answer: CertifiedAnswer }>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    request.state = "answered";
    const shared = request.shared;
    if (shared === undefined) {
      return Effect.void;
    }
    shared.answers.set(certified.recordHash, certified.answer);
    const held = shared.heldClose;
    shared.heldClose = undefined;
    return held === undefined
      ? Effect.void
      : applyClose(state, { id, request, shared }, held);
  });
}

/**
 * Reopen a request whose answer was refused. A close waiting for that answer
 * lists a record this endpoint will not hold, so it is dropped.
 */
function answerRefused(
  state: CollectiveState,
  id: CollectiveId,
  request: ReceivedRequest,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    request.state = "open";
    const shared = request.shared;
    const held = shared?.heldClose;
    if (shared === undefined || held === undefined) {
      return Effect.void;
    }
    shared.heldClose = undefined;
    return applyClose(state, { id, request, shared }, held);
  });
}

function classify(
  state: CollectiveState,
  post: CertifiedPost,
): Effect.Effect<Option.Option<InboundItem>> {
  const { message } = post;
  return readCollectiveValue(message.content).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            Option.some<InboundItem>({ kind: "multicast", message }),
          ),
        onSome: (value) => collectiveItem(state, post, value),
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
  post: CertifiedPost,
  value: CollectiveValue,
): Effect.Effect<Option.Option<InboundItem>> {
  switch (value.kind) {
    case "operation":
      return operationItem(state, post.message, value);
    case "response":
      return recordAnswer(state, post, value).pipe(Effect.as(Option.none()));
    case "close":
      return receiveClose(state, post.message, value).pipe(
        Effect.as(Option.none()),
      );
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
    case "all_gather":
      return requestItem(state, message, value);
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

/**
 * The request state a request post opens, when it arrived where its
 * operation sends it: a gather's in the member's direct conversation with
 * the requester, an all_gather's in a group conversation, whose other
 * members are the ones asked.
 */
function receivedRequest(
  message: InboundMessage,
  value: CollectingValue,
): Option.Option<ReceivedRequest> {
  const request = {
    from: message.sender,
    requestedSchema: value.requestedSchema,
    deadlineAt: value.deadlineAt,
    state: "open" as const,
  };
  if (value.op === "gather") {
    return message.kind === "direct"
      ? Option.some({ ...request, to: message.address })
      : Option.none();
  }
  if (message.kind !== "group") {
    return Option.none();
  }
  const [first, ...rest] = message.members.filter(
    (member) => member !== message.sender,
  );
  return first === undefined
    ? Option.none()
    : Option.some({
        ...request,
        to: message.address,
        shared: {
          question: questionText(message.content),
          members: [first, ...rest],
          answers: new Map(),
        },
      });
}

function questionText(content: PostContent): string {
  return withoutCollectivePart(content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Record a received gather or all_gather request and present it as an item.
 * A request in the wrong kind of conversation, one past its deadline, or one
 * reusing another requester's id is consumed.
 */
function requestItem(
  state: CollectiveState,
  message: InboundMessage,
  value: CollectingValue,
): Effect.Effect<Option.Option<InboundItem>> {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      const received = receivedRequest(message, value);
      if (now >= value.deadlineAt || Option.isNone(received)) {
        return Option.none();
      }
      const known = state.requests.get(value.id);
      if (known !== undefined && known.from !== message.sender) {
        return Option.none();
      }
      if (known === undefined) {
        forgetExpiredRequests(state, now);
        state.requests.set(value.id, received.value);
      }
      return decodeRequestedSchema(value.requestedSchema).pipe(
        Option.map(
          (requestedSchema): InboundItem => ({
            kind: "collectiveRequest",
            id: value.id,
            postId: message.postId,
            from: message.sender,
            to: received.value.to,
            question: questionText(message.content),
            requestedSchema,
            deadlineAt: value.deadlineAt,
          }),
        ),
      );
    }),
  );
}

/**
 * Forget requests past their deadline. An all_gather request stays for
 * `CLOSE_WAIT` longer, since its close follows the deadline.
 */
function forgetExpiredRequests(state: CollectiveState, now: number): void {
  const closeWait = Duration.toMillis(CLOSE_WAIT);
  for (const [id, request] of state.requests) {
    const kept = request.shared === undefined ? 0 : closeWait;
    if (now >= request.deadlineAt + kept) {
      state.requests.delete(id);
    }
  }
}

/**
 * Record an answer. At the requester, only a member's post in the
 * operation's own conversation counts, and only its first; an answer to a
 * completed or unknown operation changes nothing, and the last outstanding
 * answer completes the operation. At an all_gather member, every member's
 * answer in the group conversation is kept by record hash until the close.
 */
function recordAnswer(
  state: CollectiveState,
  post: CertifiedPost,
  value: ResponseValue,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const open = state.gathers.get(value.id);
    if (open !== undefined) {
      return recordCountedAnswer(state, open, post, value);
    }
    const request = state.requests.get(value.id);
    if (request?.shared !== undefined) {
      recordPeerAnswer(request, request.shared, post, value);
    }
    return Effect.void;
  });
}

function recordCountedAnswer(
  state: CollectiveState,
  open: OpenGather,
  post: CertifiedPost,
  value: ResponseValue,
): Effect.Effect<void> {
  const { message } = post;
  if (
    !answeredInConversation(open, message) ||
    !open.members.includes(message.sender) ||
    open.outcomes.has(message.sender)
  ) {
    return Effect.void;
  }
  return outcomeOfResponse(open.requestedSchema, value).pipe(
    Effect.flatMap((outcome) => {
      open.outcomes.set(message.sender, outcome);
      open.answerHashes.set(message.sender, post.recordHash);
      return open.outcomes.size === open.members.length
        ? completeGather(state, value.id)
        : Effect.void;
    }),
  );
}

/** Whether an answer arrived where the operation's answers are sent. */
function answeredInConversation(
  open: OpenGather,
  message: InboundMessage,
): boolean {
  switch (open.op) {
    case "gather":
      return message.kind === "direct";
    case "all_gather":
      return message.kind === "group" && message.address === open.to;
    default: {
      const exhaustive: never = open.op;
      return exhaustive;
    }
  }
}

function recordPeerAnswer(
  request: ReceivedRequest,
  shared: SharedAnswers,
  post: CertifiedPost,
  value: ResponseValue,
): void {
  const { message } = post;
  if (
    request.state !== "closed" &&
    message.kind === "group" &&
    message.address === request.to &&
    shared.members.includes(message.sender)
  ) {
    shared.answers.set(post.recordHash, {
      member: message.sender,
      response: value,
    });
  }
}

/**
 * Receive an all_gather's close. Only the requester's close in the group
 * conversation of a request this endpoint holds counts; any other close is
 * consumed and logged, and a close classified again changes nothing.
 */
function receiveClose(
  state: CollectiveState,
  message: InboundMessage,
  value: CloseValue,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const request = state.requests.get(value.id);
    if (
      request?.shared === undefined ||
      message.kind !== "group" ||
      message.address !== request.to ||
      message.sender !== request.from
    ) {
      return Effect.logWarning(
        `consumed close ${message.postId} from ${message.sender}: it closes no all_gather this endpoint was asked by its sender`,
      );
    }
    if (request.state === "closed") {
      return Effect.void;
    }
    return applyClose(
      state,
      { id: value.id, request, shared: request.shared },
      { postId: message.postId, included: value.included },
    );
  });
}

/**
 * Build a member's all_gather result from exactly the answers a close lists,
 * and emit it.
 *
 * Every listed answer precedes the close in the group conversation's
 * certified chain. The store appends a conversation's records only in chain
 * order and pending deliveries are read in that order, so each peer answer
 * the close lists was recorded before the close is classified. The member's
 * own answer is not delivered inbound: it is recorded when its send returns,
 * and a close that arrives while that send is in flight is held until it
 * returns. A listed record the endpoint still does not hold, or two listed
 * answers from one member, mean the close does not describe this endpoint's
 * history, for instance after a daemon restart; it is consumed and logged,
 * and no result is emitted.
 */
function applyClose(
  state: CollectiveState,
  asked: AskedAllGather,
  close: HeldClose,
): Effect.Effect<void> {
  const { id, request, shared } = asked;
  const answers = close.included.flatMap((hash) =>
    Option.toArray(Option.fromNullable(shared.answers.get(hash))),
  );
  if (answers.length < close.included.length && request.state === "sending") {
    shared.heldClose = close;
    return Effect.void;
  }
  request.state = "closed";
  const members = new Set(answers.map((answer) => answer.member));
  if (answers.length < close.included.length || members.size < answers.length) {
    return Effect.logWarning(
      `consumed close ${close.postId} of ${id}: it lists answers this endpoint does not hold`,
    );
  }
  return Effect.forEach(
    answers,
    (answer) =>
      outcomeOfResponse(request.requestedSchema, answer.response).pipe(
        Effect.map((outcome) => [answer.member, outcome] as const),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((outcomes) =>
      state.ports.emit({
        kind: "collectiveResult",
        id,
        to: request.to,
        question: shared.question,
        outcomes: memberOutcomes(shared.members, new Map(outcomes)),
        closePostId: close.postId,
      }),
    ),
  );
}
