/**
 * @file Gather collective as a client-side overlay over ordinary certified posts.
 *
 * The overlay owns no inbound subscription, because an endpoint allows exactly
 * one. Whoever owns that subscription routes every delivery through
 * `onDelivery` and handles the deliveries it declines. Control data rides in a
 * `data` content part that only endpoints decode, so the Router sees nothing
 * but opaque signed messages.
 *
 * ```
 * initiator                              contributor
 *    | request {id,members,deadlineAt}       |
 *    |--------------------------------------\>|  pairwise: one send per member
 *    |                                       |  shared:   one group send
 *    |          contribution {id}            |
 *    |◀--------------------------------------|
 *    v
 *  all in, or deadlineAt ──\> result(contributions, missing)
 *    │ shared only
 *    v
 *  close {id,included} ──\> every member takes the listed contributions
 * ```
 *
 * The close record names the contributors whose answers count. The cut is
 * therefore content every member reads identically, and it does not depend on
 * where a post landed in Router order, which no endpoint can observe for its
 * own posts.
 *
 * Open gathers live in memory and do not survive a restart.
 */

import {
  AgentAddress,
  type Content,
  GroupAddress,
  type HarnessEndpoint,
  type InboundDelivery,
  type InboundMessage,
  type SendError,
  type SendInput,
} from "@moltzap/client";
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Schema,
  type Scope,
} from "effect";
import { randomUUID } from "node:crypto";

const GATHER_KEY = "moltzap.gather";
/**
 * Bounds both the member list and the request fan-out, which sends at most
 * one request per member.
 */
const MAXIMUM_CONTRIBUTORS = 31;
const MINIMUM_SHARED_CONTRIBUTORS = 2;
const AGENT_ADDRESS_PREFIX = "agent:";
const DEFAULT_CLOSE_WAIT_MILLIS = 30_000;

const requestControl = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("request"),
  members: Schema.Array(AgentAddress),
  deadlineAt: Schema.Number,
});
const contributionControl = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("contribution"),
});
const closeControl = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("close"),
  included: Schema.Array(AgentAddress),
});
const gatherEnvelope = Schema.Struct({
  [GATHER_KEY]: Schema.Union(requestControl, contributionControl, closeControl),
});
const decodeEnvelope = Schema.decodeUnknownOption(gatherEnvelope);
const decodeGroupAddress = Schema.decodeUnknownOption(GroupAddress);

type GatherControl = (typeof gatherEnvelope.Type)[typeof GATHER_KEY];

/** Whether contributions travel in private pairs or in one shared group. */
type GatherTopology = "pairwise" | "shared";

/** What the single subscriber does with a delivery after the overlay saw it. */
export const DELIVERY_DISPOSITION = {
  consumed: "consumed",
  passthrough: "passthrough",
} as const;
/** One of the {@link DELIVERY_DISPOSITION} values. */
export type DeliveryDisposition =
  (typeof DELIVERY_DISPOSITION)[keyof typeof DELIVERY_DISPOSITION];

/**
 * One gather call. `members` names contributors only and never the caller.
 * `deadlineAt` is absolute epoch milliseconds on the caller's clock and may be
 * seconds or days away; it bounds the request send as well as collection.
 */
export interface GatherRequest {
  readonly members: readonly AgentAddress[];
  readonly prompt: string;
  readonly deadlineAt: number;
  readonly topology: GatherTopology;
}

/**
 * Outcome at the initiator. `closeCertified` is false for pairwise gathers and
 * for shared gathers whose group could not certify the close record, in which
 * case no other member holds a result.
 */
export interface GatherResult {
  readonly id: string;
  readonly contributions: ReadonlyMap<AgentAddress, Content>;
  readonly missing: readonly AgentAddress[];
  readonly closeCertified: boolean;
  /** The last accepted contribution, whose routing facts a host turn can reuse. */
  readonly lastAccepted: Option.Option<InboundMessage>;
}

/** A gather request as a scripted contributor sees it. */
interface ObservedGatherRequest {
  readonly id: string;
  readonly from: AgentAddress;
  readonly replyTo: SendInput["to"];
  readonly prompt: string;
  readonly deadlineAt: number;
}

/** Counts of deliveries the overlay declined or dropped, by reason. */
interface GatherCounters {
  readonly outsider: number;
  readonly wrongAddress: number;
  readonly duplicate: number;
  readonly unknownGather: number;
  readonly expiredRequest: number;
}

/** Why a gather call's member list was rejected. */
export const GATHER_INPUT_FAILURE = {
  noMembers: "no-members",
  tooManyMembers: "too-many-members",
  selfInMembers: "self-in-members",
  duplicateMember: "duplicate-member",
  sharedNeedsTwoMembers: "shared-needs-two-members",
} as const;
/** One of the {@link GATHER_INPUT_FAILURE} values. */
export type GatherInputFailure =
  (typeof GATHER_INPUT_FAILURE)[keyof typeof GATHER_INPUT_FAILURE];

/** The gather call named an unusable member list; nothing was sent. */
export class GatherInputError extends Data.TaggedError("GatherInputError")<{
  readonly reason: GatherInputFailure;
}> {
  override get message(): string {
    return `gather rejected: ${this.reason}`;
  }
}

/**
 * Dependencies of one endpoint's overlay. A `respond` handler makes the
 * overlay answer requests itself and consume group traffic, which suits a
 * scripted contributor. Without it, requests and peers' contributions pass
 * through so a model can read and answer them.
 */
export interface GatherOverlayOptions {
  readonly self: AgentAddress;
  readonly send: HarnessEndpoint["send"];
  readonly respond?: (
    request: ObservedGatherRequest,
  ) => Effect.Effect<Option.Option<string>>;
  readonly closeWaitMillis?: number;
  readonly mintId?: () => string;
  /**
   * Consume peers' contributions in a shared gather even without a `respond`
   * handler, so a model-backed member gets one turn at the close record
   * instead of one per peer.
   */
  readonly withholdPeerContributions?: boolean;
  /** Called once per shared gather when its close record reaches this member. */
  readonly onMemberResult?: (
    result: ReadonlyMap<AgentAddress, Content>,
    close: InboundMessage,
  ) => Effect.Effect<void>;
}

/** The overlay's capabilities for one endpoint. */
export interface GatherOverlay {
  readonly gather: (
    request: GatherRequest,
  ) => Effect.Effect<GatherResult, GatherInputError>;
  readonly onDelivery: (
    delivery: InboundDelivery,
  ) => Effect.Effect<DeliveryDisposition>;
  /** Send this endpoint's answer to the gather named by `id`. */
  readonly contribute: (
    id: string,
    to: SendInput["to"],
    text: string,
  ) => Effect.Effect<void, SendError>;
  /** Resolves once a shared gather's close record reaches this member. */
  readonly awaitMemberResult: (
    id: string,
  ) => Effect.Effect<ReadonlyMap<AgentAddress, Content>>;
  readonly counters: Effect.Effect<GatherCounters>;
}

interface OpenGather {
  readonly members: ReadonlySet<AgentAddress>;
  readonly topology: GatherTopology;
  readonly groupAddress: Option.Option<GroupAddress>;
  readonly contributions: Map<AgentAddress, Content>;
  readonly complete: Deferred.Deferred<undefined>;
  lastAccepted: Option.Option<InboundMessage>;
}

interface MemberView {
  readonly initiator: AgentAddress;
  readonly address: GroupAddress;
  readonly members: ReadonlySet<AgentAddress>;
  readonly contributions: Map<AgentAddress, Content>;
  ownContribution: Option.Option<Content>;
  closed: boolean;
}

type MemberResult = Deferred.Deferred<ReadonlyMap<AgentAddress, Content>>;

/**
 * Everything one endpoint's overlay remembers. The request and reply sends
 * fork into `scope`, the scope the overlay was built in.
 */
interface OverlayState {
  readonly options: GatherOverlayOptions;
  readonly scope: Scope.Scope;
  readonly openGathers: Map<string, OpenGather>;
  readonly memberViews: Map<string, MemberView>;
  readonly memberResults: Map<string, MemberResult>;
  readonly counts: { -readonly [Key in keyof GatherCounters]: number };
  readonly mintId: () => string;
  readonly withholdsPeers: boolean;
  readonly closeWait: Duration.Duration;
}

/** Content for a gather request, carrying the reply target a model must use. */
export function requestContent(
  id: string,
  request: GatherRequest,
  replyTo: string,
): Content {
  return [
    {
      type: "text",
      text: `${request.prompt}\n\nGather ${id}: reply to ${replyTo}.`,
    },
    {
      type: "data",
      value: {
        [GATHER_KEY]: {
          id,
          role: "request",
          members: request.members,
          deadlineAt: request.deadlineAt,
        },
      },
    },
  ];
}

/** Content for one member's contribution to the gather named by `id`. */
export function contributionContent(id: string, text: string): Content {
  return [
    { type: "text", text },
    { type: "data", value: { [GATHER_KEY]: { id, role: "contribution" } } },
  ];
}

/** Content for the record that fixes which contributors a shared gather counts. */
export function closeContent(
  id: string,
  included: readonly AgentAddress[],
): Content {
  return [
    { type: "data", value: { [GATHER_KEY]: { id, role: "close", included } } },
  ];
}

/**
 * Build the overlay for one endpoint. Request and reply sends run in the
 * surrounding scope, so closing it interrupts any send still waiting on a
 * peer that never certifies.
 */
export function makeGatherOverlay(
  options: GatherOverlayOptions,
): Effect.Effect<GatherOverlay, never, Scope.Scope> {
  return Effect.gen(function* () {
    const state = overlayState(options, yield* Effect.scope);
    const overlay: GatherOverlay = {
      gather: (request) => gather(state, request),
      onDelivery: (delivery) => onDelivery(state, delivery),
      contribute: (id, to, text) => contribute(state, id, to, text),
      awaitMemberResult: (id) =>
        memberResult(state, id).pipe(Effect.flatMap(Deferred.await)),
      counters: Effect.sync(() => ({ ...state.counts })),
    };
    return overlay;
  }).pipe(Effect.withSpan("makeGatherOverlay"));
}

function overlayState(
  options: GatherOverlayOptions,
  scope: Scope.Scope,
): OverlayState {
  return {
    options,
    scope,
    openGathers: new Map(),
    memberViews: new Map(),
    memberResults: new Map(),
    counts: {
      outsider: 0,
      wrongAddress: 0,
      duplicate: 0,
      unknownGather: 0,
      expiredRequest: 0,
    },
    mintId: options.mintId ?? randomUUID,
    withholdsPeers:
      options.respond !== undefined ||
      options.withholdPeerContributions === true,
    closeWait: Duration.millis(
      options.closeWaitMillis ?? DEFAULT_CLOSE_WAIT_MILLIS,
    ),
  };
}

function gather(
  state: OverlayState,
  request: GatherRequest,
): Effect.Effect<GatherResult, GatherInputError> {
  return Effect.gen(function* () {
    const invalid = validateRequest(state.options.self, request);
    if (Option.isSome(invalid)) {
      return yield* new GatherInputError({ reason: invalid.value });
    }
    const id = state.mintId();
    const now = yield* Clock.currentTimeMillis;
    if (request.deadlineAt <= now) {
      return {
        id,
        contributions: new Map<AgentAddress, Content>(),
        missing: request.members,
        closeCertified: false,
        lastAccepted: Option.none(),
      };
    }
    const open = yield* collect(state, id, request, now);
    return yield* finish(state, id, request, open);
  });
}

function validateRequest(
  self: AgentAddress,
  request: GatherRequest,
): Option.Option<GatherInputFailure> {
  if (request.members.length === 0) {
    return Option.some(GATHER_INPUT_FAILURE.noMembers);
  }
  if (request.members.length > MAXIMUM_CONTRIBUTORS) {
    return Option.some(GATHER_INPUT_FAILURE.tooManyMembers);
  }
  if (request.members.includes(self)) {
    return Option.some(GATHER_INPUT_FAILURE.selfInMembers);
  }
  if (new Set(request.members).size !== request.members.length) {
    return Option.some(GATHER_INPUT_FAILURE.duplicateMember);
  }
  if (
    request.topology === "shared" &&
    request.members.length < MINIMUM_SHARED_CONTRIBUTORS
  ) {
    return Option.some(GATHER_INPUT_FAILURE.sharedNeedsTwoMembers);
  }
  return Option.none();
}

/**
 * Open the gather, send its requests, and wait until every member answered or
 * the deadline passed. The gather is closed to further contributions on
 * return.
 */
function collect(
  state: OverlayState,
  id: string,
  request: GatherRequest,
  now: number,
): Effect.Effect<OpenGather> {
  return Effect.gen(function* () {
    const groupAddress =
      request.topology === "shared"
        ? groupAddressOf(state.options.self, request.members)
        : Option.none<GroupAddress>();
    const open: OpenGather = {
      members: new Set(request.members),
      topology: request.topology,
      groupAddress,
      contributions: new Map(),
      complete: yield* Deferred.make<undefined>(),
      lastAccepted: Option.none(),
    };
    state.openGathers.set(id, open);
    const sends = yield* Effect.forEach(
      requestSends(state, id, request, groupAddress),
      (input) => Effect.either(state.options.send(input)),
      { concurrency: MAXIMUM_CONTRIBUTORS, discard: true },
    ).pipe(Effect.forkIn(state.scope));
    yield* Deferred.await(open.complete).pipe(
      Effect.timeout(Duration.millis(request.deadlineAt - now)),
      Effect.option,
    );
    yield* Fiber.interruptFork(sends);
    state.openGathers.delete(id);
    return open;
  });
}

function groupAddressOf(
  self: AgentAddress,
  members: readonly AgentAddress[],
): Option.Option<GroupAddress> {
  const names = [self, ...members]
    .map((address) => address.slice(AGENT_ADDRESS_PREFIX.length))
    .sort(compareCodeUnits);
  return decodeGroupAddress(`group:${names.join(",")}`);
}

/** Group addresses are canonical in unsigned code-unit order, not locale order. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function requestSends(
  state: OverlayState,
  id: string,
  request: GatherRequest,
  groupAddress: Option.Option<GroupAddress>,
): readonly SendInput[] {
  if (request.topology === "shared" && Option.isSome(groupAddress)) {
    return [
      {
        to: groupAddress.value,
        content: requestContent(id, request, groupAddress.value),
      },
    ];
  }
  return request.members.map((member) => ({
    to: member,
    content: requestContent(id, request, state.options.self),
  }));
}

/** Post a shared gather's close record and build the initiator's result. */
function finish(
  state: OverlayState,
  id: string,
  request: GatherRequest,
  open: OpenGather,
): Effect.Effect<GatherResult> {
  return Effect.gen(function* () {
    const contributions = new Map(open.contributions);
    const closeCertified =
      request.topology === "shared"
        ? yield* postClose(state, id, open.groupAddress, [
            ...contributions.keys(),
          ])
        : false;
    if (closeCertified) {
      const result = yield* memberResult(state, id);
      yield* Deferred.succeed(result, contributions);
    }
    return {
      id,
      contributions,
      missing: request.members.filter((member) => !contributions.has(member)),
      closeCertified,
      lastAccepted: open.lastAccepted,
    };
  });
}

function postClose(
  state: OverlayState,
  id: string,
  groupAddress: Option.Option<GroupAddress>,
  included: readonly AgentAddress[],
): Effect.Effect<boolean> {
  if (Option.isNone(groupAddress)) {
    return Effect.succeed(false);
  }
  return state.options
    .send({ to: groupAddress.value, content: closeContent(id, included) })
    .pipe(
      Effect.as(true),
      Effect.timeoutTo({
        duration: state.closeWait,
        onSuccess: (certified) => certified,
        onTimeout: () => false,
      }),
      Effect.catchAll(() => Effect.succeed(false)),
    );
}

function onDelivery(
  state: OverlayState,
  delivery: InboundDelivery,
): Effect.Effect<DeliveryDisposition> {
  return Option.match(readControl(delivery.message), {
    onNone: () => Effect.succeed(DELIVERY_DISPOSITION.passthrough),
    onSome: (control) =>
      route(state, control, delivery.message).pipe(
        Effect.tap((disposition) =>
          disposition === DELIVERY_DISPOSITION.consumed
            ? Effect.ignore(delivery.acknowledge)
            : Effect.void,
        ),
      ),
  });
}

function readControl(message: InboundMessage): Option.Option<GatherControl> {
  for (const part of message.content) {
    if (part.type !== "data") {
      continue;
    }
    const decoded = decodeEnvelope(part.value);
    if (Option.isSome(decoded)) {
      return Option.some(decoded.value[GATHER_KEY]);
    }
  }
  return Option.none();
}

function route(
  state: OverlayState,
  control: GatherControl,
  message: InboundMessage,
): Effect.Effect<DeliveryDisposition> {
  switch (control.role) {
    case "request":
      return onRequest(state, control, message);
    case "contribution":
      return onContribution(state, control.id, message);
    case "close":
      return onClose(state, control, message);
    default:
      return Effect.succeed(DELIVERY_DISPOSITION.passthrough);
  }
}

function onRequest(
  state: OverlayState,
  control: typeof requestControl.Type,
  message: InboundMessage,
): Effect.Effect<DeliveryDisposition> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (control.deadlineAt <= now) {
      state.counts.expiredRequest += 1;
      return DELIVERY_DISPOSITION.consumed;
    }
    if (message.kind === "group") {
      state.memberViews.set(control.id, {
        initiator: message.sender,
        address: message.address,
        members: new Set(control.members),
        contributions: new Map(),
        ownContribution: Option.none(),
        closed: false,
      });
    }
    const respond = state.options.respond;
    if (
      respond === undefined ||
      !control.members.includes(state.options.self)
    ) {
      return DELIVERY_DISPOSITION.passthrough;
    }
    yield* answer(state, respond, {
      id: control.id,
      from: message.sender,
      replyTo: message.address,
      prompt: readText(message.content),
      deadlineAt: control.deadlineAt,
    });
    return DELIVERY_DISPOSITION.consumed;
  });
}

function answer(
  state: OverlayState,
  respond: NonNullable<GatherOverlayOptions["respond"]>,
  observed: ObservedGatherRequest,
): Effect.Effect<void> {
  return respond(observed).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (text) =>
          Effect.ignore(contribute(state, observed.id, observed.replyTo, text)),
      }),
    ),
    Effect.forkIn(state.scope),
    Effect.asVoid,
  );
}

/**
 * An endpoint is never offered its own post, so a member keeps what it sent
 * and learns from the close record whether the initiator counted it.
 */
function contribute(
  state: OverlayState,
  id: string,
  to: SendInput["to"],
  text: string,
): Effect.Effect<void, SendError> {
  const content = contributionContent(id, text);
  const view = state.memberViews.get(id);
  if (view !== undefined && Option.isNone(view.ownContribution)) {
    view.ownContribution = Option.some(content);
  }
  return state.options.send({ to, content });
}

function readText(content: Content): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function onContribution(
  state: OverlayState,
  id: string,
  message: InboundMessage,
): Effect.Effect<DeliveryDisposition> {
  return Effect.suspend(() => {
    const open = state.openGathers.get(id);
    if (open !== undefined) {
      return acceptAsInitiator(state, open, message);
    }
    const view = state.memberViews.get(id);
    if (view !== undefined) {
      return Effect.succeed(observeAsMember(state, view, message));
    }
    state.counts.unknownGather += 1;
    return Effect.succeed(DELIVERY_DISPOSITION.passthrough);
  });
}

function acceptAsInitiator(
  state: OverlayState,
  open: OpenGather,
  message: InboundMessage,
): Effect.Effect<DeliveryDisposition> {
  return Effect.suspend(() => {
    if (!open.members.has(message.sender)) {
      state.counts.outsider += 1;
      return Effect.succeed(DELIVERY_DISPOSITION.passthrough);
    }
    const expected = Option.getOrElse(open.groupAddress, () => message.sender);
    if (message.address !== expected) {
      state.counts.wrongAddress += 1;
      return Effect.succeed(DELIVERY_DISPOSITION.passthrough);
    }
    if (open.contributions.has(message.sender)) {
      state.counts.duplicate += 1;
      return Effect.succeed(DELIVERY_DISPOSITION.passthrough);
    }
    open.contributions.set(message.sender, message.content);
    open.lastAccepted = Option.some(message);
    const finished = open.contributions.size === open.members.size;
    return (
      finished ? Deferred.succeed(open.complete, undefined) : Effect.void
    ).pipe(Effect.as(DELIVERY_DISPOSITION.consumed));
  });
}

function observeAsMember(
  state: OverlayState,
  view: MemberView,
  message: InboundMessage,
): DeliveryDisposition {
  const counted =
    message.address === view.address &&
    view.members.has(message.sender) &&
    !view.contributions.has(message.sender);
  if (counted) {
    view.contributions.set(message.sender, message.content);
  }
  return state.withholdsPeers
    ? DELIVERY_DISPOSITION.consumed
    : DELIVERY_DISPOSITION.passthrough;
}

function onClose(
  state: OverlayState,
  control: typeof closeControl.Type,
  message: InboundMessage,
): Effect.Effect<DeliveryDisposition> {
  const id = control.id;
  return Effect.gen(function* () {
    const view = state.memberViews.get(id);
    if (
      view === undefined ||
      view.closed ||
      message.sender !== view.initiator ||
      message.address !== view.address
    ) {
      return DELIVERY_DISPOSITION.passthrough;
    }
    view.closed = true;
    const result = yield* memberResult(state, id);
    const listed = listedContributions(state, view, control.included);
    yield* Deferred.succeed(result, listed);
    if (state.options.onMemberResult !== undefined) {
      yield* state.options.onMemberResult(listed, message);
    }
    return DELIVERY_DISPOSITION.consumed;
  });
}

function listedContributions(
  state: OverlayState,
  view: MemberView,
  included: readonly AgentAddress[],
): ReadonlyMap<AgentAddress, Content> {
  const listed = new Map<AgentAddress, Content>();
  for (const member of included) {
    const content =
      member === state.options.self
        ? Option.getOrUndefined(view.ownContribution)
        : view.contributions.get(member);
    if (content !== undefined) {
      listed.set(member, content);
    }
  }
  return listed;
}

function memberResult(
  state: OverlayState,
  id: string,
): Effect.Effect<MemberResult> {
  return Effect.suspend(() => {
    const existing = state.memberResults.get(id);
    if (existing !== undefined) {
      return Effect.succeed(existing);
    }
    return Deferred.make<ReadonlyMap<AgentAddress, Content>>().pipe(
      Effect.tap((created) =>
        Effect.sync(() => state.memberResults.set(id, created)),
      ),
    );
  });
}
