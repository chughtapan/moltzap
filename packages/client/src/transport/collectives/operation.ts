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
 *   alt no request post is accepted
 *     RE-->>RM: error naming each unreachable member
 *   else some request post accepted
 *     RE-->>RM: operation id
 *     RE->>RE: record each refused or uncertified member as no-answer
 *   end
 *   ME->>MM: collectiveRequest item
 *   MM->>ME: send collectiveResponse to the requester, action, content
 *   ME->>ME: match the request open in that conversation&lt;br>validate content against its schema
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
 *   MM->>ME: send collectiveResponse to the group, action, content
 *   ME->>ME: match the request open in the group&lt;br>validate content against its schema
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
  Fiber,
  Option,
  ParseResult,
  Schema,
  type Scope,
} from "effect";
import type { EngineSendInput, EngineSentPost } from "../messaging/index.js";
import type { InboundMessage } from "../messaging/message.js";
import type { CollectiveMemberOutcome, InboundItem } from "./inbound.js";
import { canonicalMessageAddress } from "../messaging/address.js";
import {
  AgentAddress,
  type MessageAddressInput,
  type PostId,
  type RecordHash,
} from "../wire/index.js";
import { SendError } from "../messaging/errors.js";
import {
  type CollectiveSendOutcome,
  emitFailureAsSendError,
  refusedAs,
  type RefusedSend,
  reportFailure,
} from "./failures.js";
import {
  type CollectiveEmitError,
  CollectiveError,
  type CollectiveFailure,
  type CollectiveId,
  type CollectiveOperation,
  type CollectiveResponse,
  type FailureDelivery,
  MAXIMUM_DEADLINE_SECONDS,
  RequestedSchema,
  type SendInput,
} from "./forms.js";
import {
  matchOpenRequest,
  type OpenRequest,
  type RequestStatus,
} from "./received-request.js";
import {
  isAddressRefusal,
  lookupRefusals,
  type RequestRefusal,
  type RequestSend,
  requestsSoFar,
} from "./request-sends.js";
import {
  type CertifiedAnswer,
  type CollectiveResultItem,
  type HeldClose,
  keepFirstAnswer,
  listedAnswers,
  memberOutcomes,
  type Members,
  type ResponseValue,
  type SharedAnswers,
} from "./shared-answers.js";
import { outcomeOfResponse, validateAnswer } from "./validation.js";
import {
  collectiveIdOf,
  type CollectiveValue,
  encodeCollectiveContent,
  FormModeSchema,
  mintCollectiveId,
  readCollectiveValue,
  withoutCollectivePart,
} from "./part/index.js";

type PostContent = InboundMessage["content"];

type CollectingOperation = Extract<
  CollectiveOperation,
  { readonly deadline: number }
>;

type CollectingValue = Extract<
  CollectiveValue,
  { readonly kind: "operation"; readonly op: "gather" | "all_gather" }
>;

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

/**
 * The longest single sleep a deadline timer takes. A JavaScript timer longer
 * than about 24.8 days never fires, so a longer deadline is reached in steps.
 */
const DEADLINE_TIMER_STEP = Duration.days(1);

/**
 * How far past the longest deadline a sender may state a received request's
 * deadline still lies. It absorbs clock skew between the two endpoints; a
 * request further out is consumed, which bounds how long its state is held
 * and keeps every stored deadline a representable date.
 */
const RECEIVED_DEADLINE_ALLOWANCE = Duration.hours(1);

/** The furthest past `now` a received request's deadline may lie. */
const RECEIVED_DEADLINE_HORIZON = Duration.toMillis(
  Duration.sum(
    Duration.seconds(MAXIMUM_DEADLINE_SECONDS),
    RECEIVED_DEADLINE_ALLOWANCE,
  ),
);

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
  /**
   * Queue an item the layer emits itself: a result or a failure. It fails
   * when the item cannot be kept, which ends the work that emitted it.
   */
  readonly emit: (
    item: InboundItem,
  ) => Effect.Effect<void, CollectiveEmitError>;
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

/** The daemon's collective layer for one active identity. */
export interface CollectiveOperations {
  /**
   * Perform one send. A gather completes once its request posts are
   * settled, recording each member it did not reach as no-answer, and
   * fails naming every member only when it reached none; an all_gather
   * completes once its group post is certified. A response answers the one
   * request open in the conversation its address names, validated against
   * that request's schema.
   */
  readonly send: (
    input: SendInput,
    failureDelivery: FailureDelivery,
  ) => Effect.Effect<CollectiveSendOutcome, SendError | CollectiveError>;
  /**
   * Classify one certified remote post. Answers are recorded and consumed,
   * every other protocol post is consumed, and each remaining post becomes
   * one item. Classifying a post again yields the same result, so the daemon
   * may run it on every pass over pending deliveries. It fails with
   * `CollectiveEmitError` when a result or failure the post completes cannot
   * be kept, which ends the pass classifying it.
   */
  readonly classify: (
    post: CertifiedPost,
  ) => Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError>;
}

/**
 * A gather or all_gather this endpoint started, before its deadline timer is
 * running. `answerHashes` holds the certified record of each counted answer,
 * which an all_gather's close lists.
 */
interface GatherRequest {
  readonly op: CollectingOperation["op"];
  readonly to: MessageAddressInput;
  readonly question: string;
  readonly members: Members;
  readonly requestedSchema: FormModeSchema;
  readonly outcomes: Map<AgentAddress, CollectiveMemberOutcome>;
  readonly answerHashes: Map<AgentAddress, RecordHash>;
}

/**
 * An operation this endpoint started that has not completed. `timer`
 * completes it at its deadline; completing it earlier interrupts the timer.
 */
interface OpenGather extends GatherRequest {
  readonly timer: Fiber.RuntimeFiber<void>;
  requestsSettled: boolean;
}

/**
 * A request this endpoint received. `postId` is the request post it came in,
 * and every answer goes to `to`. A refused answer reopens the request; an
 * all_gather request carries `shared`.
 */
interface ReceivedRequest extends RequestStatus {
  readonly postId: PostId;
  readonly from: AgentAddress;
  readonly requestedSchema: FormModeSchema;
  state: RequestStatus["state"];
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

const decodeAgentAddress = Schema.decodeUnknownOption(AgentAddress);
const decodeRequestedSchema = Schema.decodeUnknownOption(RequestedSchema);

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
            state.ports.emit,
            failureDelivery,
            respond(state, input.to, input.collectiveResponse),
          )
        : sendOperation(state, input, failureDelivery),
    classify: (message) => classify(state, message),
  };
};

function sendOperation(
  state: CollectiveState,
  input: Extract<SendInput, { readonly text: string }>,
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
        state.ports.emit,
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

/** A collecting operation's canonical address and the members it asks. */
interface GatherAddress {
  readonly to: MessageAddressInput;
  readonly members: Members;
}

/**
 * The canonical address a collecting operation's result and failure name, by
 * the rule every send shares, and the members it asks: the one agent of an
 * `agent:` address, or every member of a group but the requester. An
 * all_gather asks a group in its conversation, so an `agent:` address is
 * refused as `membership-invalid`.
 */
function gatherAddress(
  to: MessageAddressInput,
  self: AgentAddress,
  op: CollectingOperation["op"],
): Effect.Effect<GatherAddress, SendError> {
  const selfName = self.slice("agent:".length);
  const membershipInvalid = new SendError({
    reason: "membership-invalid",
    detail: "an all_gather asks a group of two or more other agents",
  });
  return canonicalMessageAddress(to, selfName).pipe(
    Effect.flatMap((canonical): Effect.Effect<GatherAddress, SendError> => {
      if (canonical.kind === "direct") {
        return op === "gather"
          ? Effect.succeed({
              to: canonical.address,
              members: [canonical.address],
            })
          : Effect.fail(membershipInvalid);
      }
      const [first, ...rest] = canonical.memberNames
        .filter((name) => name !== selfName)
        .flatMap((name) => Option.toArray(decodeAgentAddress(`agent:${name}`)));
      return first === undefined
        ? Effect.fail(membershipInvalid)
        : Effect.succeed({ to: canonical.address, members: [first, ...rest] });
    }),
  );
}

/**
 * A validated gather ready to fan out: its state, the request content every
 * member receives, its absolute deadline, and the milliseconds left until it.
 */
interface PreparedGather {
  readonly id: CollectiveId;
  readonly open: GatherRequest;
  readonly content: PostContent;
  readonly deadlineAt: number;
  readonly untilDeadline: number;
}

/**
 * Check a collecting operation's schema against the MCP form-mode grammar.
 * The failure's detail is one line per issue, each led by its path within
 * the schema, such as `properties.slots: items.type: ...`, because the
 * requester's model repairs the form from this text alone.
 */
function formModeSchema(
  id: CollectiveId,
  requestedSchema: CollectingOperation["requestedSchema"],
): Effect.Effect<FormModeSchema, CollectiveError> {
  return Schema.decodeUnknown(FormModeSchema)(requestedSchema).pipe(
    Effect.mapError((error) =>
      collectiveFailure(id, {
        kind: "schema-invalid",
        detail: ParseResult.ArrayFormatter.formatErrorSync(error)
          .map(({ path, message }) =>
            path.length === 0
              ? message
              : `${path.map(String).join(".")}: ${message}`,
          )
          .join("; "),
      }),
    ),
  );
}

/**
 * Validate a gather or all_gather before any post: mint its id, check its
 * schema against the form-mode grammar, name and resolve its members, fix
 * its absolute deadline, and build the request content within the content
 * limit.
 */
function prepareGather(
  state: CollectiveState,
  requestedTo: MessageAddressInput,
  question: string,
  operation: CollectingOperation,
): Effect.Effect<PreparedGather, RefusedSend<SendError | CollectiveError>> {
  return Effect.gen(function* () {
    const { id, nonce } = yield* mintCollectiveId(state.ports.self);
    const { to, members } = yield* gatherAddress(
      requestedTo,
      state.ports.self,
      operation.op,
    ).pipe(Effect.mapError(refusedAs(id, requestedTo)));
    const refused = refusedAs<SendError | CollectiveError>(id, to);
    const requestedSchema = yield* formModeSchema(
      id,
      operation.requestedSchema,
    ).pipe(Effect.mapError(refused));
    yield* refuseAddressErrors(state, members).pipe(
      Effect.mapError((failure) => refused(collectiveFailure(id, failure))),
    );
    const now = yield* Clock.currentTimeMillis;
    const untilDeadline = Duration.toMillis(
      Duration.seconds(operation.deadline),
    );
    const deadlineAt = now + untilDeadline;
    const content = yield* encodeCollectiveContent(
      {
        kind: "operation",
        op: operation.op,
        id,
        nonce,
        deadlineAt,
        requestedSchema,
      },
      question,
    ).pipe(Effect.mapError(() => refused(contentInvalid())));
    const open: GatherRequest = {
      op: operation.op,
      to,
      question,
      members,
      requestedSchema,
      outcomes: new Map(),
      answerHashes: new Map(),
    };
    return { id, open, content, deadlineAt, untilDeadline };
  });
}

/**
 * Start the operation's deadline timer, open it so answers can be recorded
 * while its requests are still being sent, and send them.
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
    const timer = yield* sleepUntil(prepared.deadlineAt).pipe(
      Effect.zipRight(Effect.ignore(completeGather(state, prepared.id))),
      Effect.forkIn(state.ports.scope),
    );
    yield* Effect.sync(() => {
      state.gathers.set(prepared.id, {
        ...prepared.open,
        timer,
        requestsSettled: prepared.open.op === "all_gather",
      });
    });
    const requests =
      prepared.open.op === "gather"
        ? sendRequests(state, prepared)
        : sendGroupRequest(state, prepared).pipe(
            Effect.map((postIds) => ({ postIds })),
          );
    const sent = yield* requests.pipe(
      Effect.mapError(
        refusedAs<SendError | CollectiveError>(prepared.id, prepared.open.to),
      ),
    );
    return { ...sent, operationId: prepared.id };
  });
}

/**
 * Resolve every member before any post through the engine's address
 * resolution. A malformed or unknown member, or invalid membership, refuses
 * the whole send naming each one; any other lookup failure is left to the
 * post, which reports it as a delivery failure.
 */
function refuseAddressErrors(
  state: CollectiveState,
  members: Members,
): Effect.Effect<void, CollectiveFailure> {
  return lookupRefusals(members, state.ports.lookupMember).pipe(
    Effect.map((refusals) => refusals.filter(isAddressRefusal)),
    Effect.flatMap(([first, ...rest]) =>
      first === undefined
        ? Effect.void
        : Effect.fail<CollectiveFailure>({
            kind: "members-unreachable",
            members: [first, ...rest],
          }),
    ),
  );
}

/** Sleep until the absolute time `at`, in steps no timer overflows. */
function sleepUntil(at: number): Effect.Effect<void> {
  return Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      now >= at
        ? Effect.void
        : Effect.sleep(
            Duration.min(Duration.millis(at - now), DEADLINE_TIMER_STEP),
          ).pipe(Effect.zipRight(sleepUntil(at))),
    ),
  );
}

/**
 * Send one request post per member, waiting at most the send wait. A pending
 * send keeps running and settles its member when it completes: certified
 * asks it, refused makes it `no-answer`, as does pending at the deadline.
 * The send fails only when every post was refused and the gather has not
 * completed, so an operation ends in exactly one refusal or one result, or
 * as persistence-failed when the result its settling completes cannot be
 * kept.
 */
function sendRequests(
  state: CollectiveState,
  prepared: PreparedGather,
): Effect.Effect<CollectiveSendOutcome, CollectiveError | SendError> {
  return Effect.gen(function* () {
    const { id, open } = prepared;
    const sends = yield* Effect.forEach(
      open.members,
      (member): Effect.Effect<RequestSend> =>
        state.ports.sendPost({ to: member, content: prepared.content }).pipe(
          Effect.mapError((error) => ({ member, reason: error.reason })),
          Effect.tapError((refusal) => recordRefusal(state, id, refusal)),
          Effect.either,
          Effect.forkIn(state.ports.scope),
        ),
      { concurrency: 1 },
    );
    yield* Fiber.awaitAll(sends).pipe(
      Effect.timeoutOption(requestWait(state, prepared)),
    );
    const { posts, refused } = yield* requestsSoFar(open.members, sends);
    const [refusal, ...refusals] = refused;
    if (
      refusal !== undefined &&
      refusals.length + 1 === open.members.length &&
      state.gathers.has(id)
    ) {
      yield* forgetGather(state, id);
      return yield* Effect.fail(
        collectiveFailure(id, {
          kind: "members-unreachable",
          members: [refusal, ...refusals],
        }),
      );
    }
    yield* emitFailureAsSendError(
      updateGather(state, id, (settled) => {
        settled.requestsSettled = true;
      }),
    );
    return { postIds: posts.map((post) => post.postId) };
  });
}

/** Record a member whose request post was refused as `no-answer`. */
function recordRefusal(
  state: CollectiveState,
  id: CollectiveId,
  { member }: RequestRefusal,
): Effect.Effect<void> {
  return Effect.ignore(
    updateGather(state, id, ({ outcomes }) => {
      if (!outcomes.has(member)) {
        outcomes.set(member, { kind: "no-answer" });
      }
    }),
  );
}

/**
 * Apply a change to an open gather, then complete it once its send has
 * returned and every member has an outcome. Until the send returns, only the
 * send decides whether the gather is refused, so no path can emit both a
 * refusal and a result.
 */
function updateGather(
  state: CollectiveState,
  id: CollectiveId,
  change: (open: OpenGather) => void,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    if (open === undefined) {
      return Effect.void;
    }
    change(open);
    return open.requestsSettled && open.outcomes.size === open.members.length
      ? completeGather(state, id).pipe(
          Effect.zipRight(Fiber.interrupt(open.timer)),
        )
      : Effect.void;
  });
}

/**
 * Send an all_gather's one request post to the group and wait for it, never
 * past the deadline. A refused post, or one still uncertified when the wait
 * ends, abandons the all_gather: the group's GENESIS needs every member. The
 * operation is dropped before its unreachable members are looked up, so a
 * deadline that passes during the lookups cannot close it.
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
        forgetGather(state, prepared.id).pipe(
          Effect.zipRight(
            unreachableMembers(state, prepared.open.members, error.reason),
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
  return lookupRefusals(members, state.ports.lookupMember).pipe(
    Effect.map(([first, ...rest]) =>
      first === undefined
        ? EffectArray.map(members, (member) => ({
            member,
            reason: groupReason,
          }))
        : [first, ...rest],
    ),
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

/** Drop an operation this endpoint abandons, and stop its deadline timer. */
function forgetGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const open = state.gathers.get(id);
    state.gathers.delete(id);
    return open === undefined ? Effect.void : Fiber.interrupt(open.timer);
  });
}

/**
 * Complete an operation this endpoint started. A gather emits its result
 * now; an all_gather first posts its close, off the calling fiber because
 * completion can run inside a publication pass that certification waits on.
 * An operation completes once; a later call does nothing. The deadline timer
 * calls it too, so it leaves the timer to its caller.
 */
function completeGather(
  state: CollectiveState,
  id: CollectiveId,
): Effect.Effect<void, CollectiveEmitError> {
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
): Effect.Effect<void, CollectiveEmitError> {
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
          error: `all_gather ${result.id} failed: its close was not certified (${error.reason})`,
        }),
      onSuccess: (post) =>
        state.ports.emit({ ...result, closePostId: post.postId }),
    }),
  );
}

/**
 * Answer the one request open in the conversation `to` names. The answer
 * carries no request id, so the conversation decides which request it
 * answers; with none open, or several, nothing is sent.
 */
function respond(
  state: CollectiveState,
  to: MessageAddressInput,
  response: CollectiveResponse,
): Effect.Effect<
  CollectiveSendOutcome,
  RefusedSend<SendError | CollectiveError>
> {
  return Effect.gen(function* () {
    const { id, request } = yield* openRequest(state, to);
    const refused = refusedAs<SendError | CollectiveError>(id, request.to);
    const value: ResponseValue = { kind: "response", id, ...response };
    const content = yield* responseContent(request, value).pipe(
      Effect.mapError(refused),
    );
    yield* claimRequest(id, request).pipe(Effect.mapError(refused));
    const post = yield* state.ports.sendPost({ to: request.to, content }).pipe(
      Effect.tapBoth({
        onFailure: () => settleAnswer(state, id, request, Option.none()),
        onSuccess: (sent) =>
          settleAnswer(
            state,
            id,
            request,
            Option.some({ recordHash: sent.recordHash, response: value }),
          ),
      }),
      Effect.onInterrupt(() =>
        Effect.ignore(settleAnswer(state, id, request, Option.none())),
      ),
      emitFailureAsSendError,
      Effect.mapError(refused),
    );
    return { operationId: id, postIds: [post.postId] };
  });
}

/**
 * The one request open in the conversation `to` names. A refusal names an id
 * minted for it, since no single request is answered.
 */
function openRequest(
  state: CollectiveState,
  to: MessageAddressInput,
): Effect.Effect<
  OpenRequest<ReceivedRequest>,
  RefusedSend<SendError | CollectiveError>
> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { id } = yield* mintCollectiveId(state.ports.self);
    const self = state.ports.self.slice("agent:".length);
    const { address } = yield* canonicalMessageAddress(to, self).pipe(
      Effect.mapError(refusedAs<SendError | CollectiveError>(id, to)),
    );
    return yield* matchOpenRequest(state.requests, address, now).pipe(
      Effect.mapError((kind) =>
        refusedAs<SendError | CollectiveError>(
          id,
          address,
        )(collectiveFailure(id, { kind })),
      ),
    );
  });
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
 * Settle a request's answer send: answered with the certified answer, or
 * reopened when it was refused. A member's own answer never arrives inbound,
 * so an all_gather member records it here, and applies a close that was
 * waiting for it; after a refused answer that close lists a record this
 * endpoint will not hold, so applying it drops it. A request already closed
 * stays closed: its result is out, and a close delivered again must not
 * apply a second time.
 */
function settleAnswer(
  state: CollectiveState,
  id: CollectiveId,
  request: ReceivedRequest,
  certified: Option.Option<CertifiedAnswer>,
): Effect.Effect<void, CollectiveEmitError> {
  return Effect.suspend(() => {
    if (request.state === "closed") {
      return Effect.void;
    }
    request.state = Option.isSome(certified) ? "answered" : "open";
    const shared = request.shared;
    if (shared === undefined) {
      return Effect.void;
    }
    if (Option.isSome(certified)) {
      shared.answers.set(state.ports.self, certified.value);
    }
    const held = shared.heldClose;
    shared.heldClose = undefined;
    return held === undefined
      ? Effect.void
      : applyClose(state, { id, request, shared }, held);
  });
}

function classify(
  state: CollectiveState,
  post: CertifiedPost,
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
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
): Effect.Effect<Option.Option<InboundItem>, CollectiveEmitError> {
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
 * operation sends it and its id derives from its sender: a gather's in the
 * member's direct conversation with the requester before its deadline, an
 * all_gather's in a group conversation, whose other members are the ones
 * asked, until `CLOSE_WAIT` past its deadline. A deadline beyond
 * `RECEIVED_DEADLINE_HORIZON` opens nothing.
 */
function receivedRequest(
  message: InboundMessage,
  value: CollectingValue,
  now: number,
): Option.Option<ReceivedRequest> {
  if (!trustedRequest(message, value, now)) {
    return Option.none();
  }
  const request = {
    postId: message.postId,
    from: message.sender,
    to: message.address,
    requestedSchema: value.requestedSchema,
    deadlineAt: value.deadlineAt,
    state: "open" as const,
  };
  if (value.op === "gather") {
    return message.kind === "direct" && now < value.deadlineAt
      ? Option.some(request)
      : Option.none();
  }
  if (message.kind !== "group" || now >= retainedUntil(request, true)) {
    return Option.none();
  }
  const [first, ...rest] = message.members.filter(
    (member) => member !== message.sender,
  );
  return first === undefined
    ? Option.none()
    : Option.some({
        ...request,
        shared: {
          question: questionText(message.content),
          members: [first, ...rest],
          answers: new Map(),
        },
      });
}

/**
 * Whether a request's id derives from its sender and its deadline lies
 * within `RECEIVED_DEADLINE_HORIZON`.
 */
function trustedRequest(
  message: InboundMessage,
  value: CollectingValue,
  now: number,
): boolean {
  return (
    value.deadlineAt <= now + RECEIVED_DEADLINE_HORIZON &&
    collectiveIdOf(message.sender, value.nonce) === value.id
  );
}

function questionText(content: PostContent): string {
  return withoutCollectivePart(content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Record a received gather or all_gather request and present it as an item.
 * A request `receivedRequest` opens nothing for is consumed. So is a second
 * request post reusing an id this endpoint holds: the answer goes to the
 * conversation of the first, so presenting the second would show the host a
 * different audience. An all_gather request past its deadline is kept
 * without being presented, so a member that catches up late still applies
 * the close and receives the result.
 */
function requestItem(
  state: CollectiveState,
  message: InboundMessage,
  value: CollectingValue,
): Effect.Effect<Option.Option<InboundItem>> {
  return Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      const received = receivedRequest(message, value, now);
      const held = state.requests.get(value.id);
      if (
        Option.isNone(received) ||
        (held ?? received.value).postId !== message.postId
      ) {
        return Option.none();
      }
      if (held === undefined) {
        forgetExpiredRequests(state, now);
        state.requests.set(value.id, received.value);
      }
      return decodeRequestedSchema(value.requestedSchema).pipe(
        Option.filter(() => now < value.deadlineAt),
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

/** Forget every request past the time `retainedUntil` gives it. */
function forgetExpiredRequests(state: CollectiveState, now: number): void {
  for (const [id, request] of state.requests) {
    if (now >= retainedUntil(request, request.shared !== undefined)) {
      state.requests.delete(id);
    }
  }
}

/**
 * When this endpoint drops a received request: at its deadline, or for an
 * all_gather `CLOSE_WAIT` later, since its close follows the deadline.
 */
function retainedUntil(
  request: Pick<ReceivedRequest, "deadlineAt">,
  allGather: boolean,
): number {
  return request.deadlineAt + (allGather ? Duration.toMillis(CLOSE_WAIT) : 0);
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
): Effect.Effect<void, CollectiveEmitError> {
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
): Effect.Effect<void, CollectiveEmitError> {
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
      return updateGather(state, value.id, () => {
        open.outcomes.set(message.sender, outcome);
        open.answerHashes.set(message.sender, post.recordHash);
      });
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
    request.state === "closed" ||
    message.kind !== "group" ||
    message.address !== request.to
  ) {
    return;
  }
  keepFirstAnswer(shared, message.sender, {
    recordHash: post.recordHash,
    response: value,
  });
}

/**
 * Receive an all_gather's close. Only the requester's close in the group
 * conversation of a request this endpoint holds counts. The held request's id
 * derives from its requester, so a close from any other sender names an id
 * that does not derive from that sender; it, and a close for an id this
 * endpoint does not hold, is consumed and logged. Only the first close in the
 * conversation counts, as at every other member: a later one, including one
 * that arrives while the first is held, changes nothing.
 */
function receiveClose(
  state: CollectiveState,
  message: InboundMessage,
  value: CloseValue,
): Effect.Effect<void, CollectiveEmitError> {
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
    if (request.state === "closed" || request.shared.heldClose !== undefined) {
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
 * returns. A listed record the endpoint still does not hold, or one listed
 * twice, means the close does not describe this endpoint's history, for
 * instance after a daemon restart; it is consumed and logged, and no result
 * is emitted. Once closed, the request keeps no answers.
 */
function applyClose(
  state: CollectiveState,
  asked: AskedAllGather,
  close: HeldClose,
): Effect.Effect<void, CollectiveEmitError> {
  const { id, request, shared } = asked;
  const { answers, missing, repeated } = listedAnswers(shared, close.included);
  if (missing && request.state === "sending") {
    shared.heldClose = close;
    return Effect.void;
  }
  request.state = "closed";
  shared.answers.clear();
  if (missing || repeated) {
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
