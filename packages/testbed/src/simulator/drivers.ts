/**
 * @file Registered driver implementations (contract 4 internals). Run
 * specs reference drivers by name plus JSON config, never by closure;
 * names resolve here at materialization time, so an unregistered name or
 * a config the driver rejects never reaches launch. The v0 registry is
 * the closed built-in set below; consumer-supplied driver processes are
 * a staged-later surface.
 */
import { Effect, Schema, type Scope } from "effect";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import { MessagesSend } from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type {
  AgentName,
  DriverRef,
  PrincipalName,
  SpeechStep,
} from "./run-spec.js";
import type {
  ChannelRef,
  Principal,
  SpeechDelivery,
  SpeechReceipt,
} from "./episode.js";
import type { Society } from "./run-config.js";
import type { SimulatorEvent } from "./event-log.js";
import {
  makeDeliveredLog,
  MESSAGE_DELIVERED_SPAN,
  readDeliveredMessage,
  type AnswerCriteria,
} from "./span-attrs.js";
import type { Secrets } from "./recording.js";
import {
  DoneSignalUnsafe,
  DriverConfigRejected,
  SpeechFailed,
  UnknownDriver,
} from "./errors.js";
import {
  agentKeyValue,
  httpBaseFromServerUrl,
  registerIdentity,
  type MintedIdentity,
} from "./provisioning.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const OUT_OF_BAND_PRINCIPAL = "out-of-band";
const SPAN_NAME_DONE_SIGNAL = "span-name";
const REPLIES_DONE_SIGNAL = "replies";

/** The one done-signal that tracks the schedule rather than the traffic. */
export const LAST_STEP_ANSWERED_DONE_SIGNAL = "last-step-answered";

export type DriverKind = "principal" | "done-signal";

/** Config of the `span-name` done-signal predicate. */
const SpanNameDoneConfig = Schema.Struct({
  name: Schema.NonEmptyString.annotations({
    description: "Span name that signals episode completion",
  }),
  minCount: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.positive(),
      Schema.annotations({
        description: "Number of matching spans required before firing",
      }),
    ),
    { default: () => 1 },
  ),
});

/** Config of the `replies` done-signal predicate. */
const RepliesDoneConfig = Schema.Struct({
  from: Schema.NonEmptyString.annotations({
    description: "Agent whose committed messages are counted",
  }),
  minCount: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.positive(),
      Schema.annotations({
        description: "Messages from that agent required before firing",
      }),
    ),
    { default: () => 1 },
  ),
});

/** Config of the `last-step-answered` done-signal predicate. */
const LastStepAnsweredConfig = Schema.Struct({
  from: Schema.optional(
    Schema.NonEmptyString.annotations({
      description:
        "Agent whose response ends the episode; any non-speaker participant of the last step when omitted",
    }),
  ),
});

/** Config of the `out-of-band` principal (no knobs in v0). */
const OutOfBandPrincipalConfig = Schema.Struct({});

const REGISTERED_DRIVERS: Readonly<
  Record<
    string,
    {
      readonly kind: DriverKind;
      readonly config: Schema.Schema.AnyNoContext;
      /** Fires on society traffic rather than on the schedule's progress. */
      readonly tracksTraffic: boolean;
    }
  >
> = {
  [OUT_OF_BAND_PRINCIPAL]: {
    kind: "principal",
    config: OutOfBandPrincipalConfig,
    tracksTraffic: false,
  },
  [SPAN_NAME_DONE_SIGNAL]: {
    kind: "done-signal",
    config: SpanNameDoneConfig,
    tracksTraffic: true,
  },
  [REPLIES_DONE_SIGNAL]: {
    kind: "done-signal",
    config: RepliesDoneConfig,
    tracksTraffic: true,
  },
  [LAST_STEP_ANSWERED_DONE_SIGNAL]: {
    kind: "done-signal",
    config: LastStepAnsweredConfig,
    tracksTraffic: false,
  },
};

function configRejected(
  ref: DriverRef,
): (cause: { readonly message: string }) => DriverConfigRejected {
  return (cause) =>
    new DriverConfigRejected({
      name: ref.name,
      field: cause.message.split("\n")[0] ?? "config",
      message: `Driver "${ref.name}" rejected its config: ${cause.message}. Fix the driver config fields to match the driver's schema.`,
    });
}

function decodeDriverConfig<A, I>(
  ref: DriverRef,
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, DriverConfigRejected> {
  return Schema.decodeUnknown(schema)(ref.config).pipe(
    Effect.mapError(configRejected(ref)),
  );
}

/**
 * Resolve one driver reference against the registry: unknown names and
 * rejected configs fail here, at config time, never at launch.
 */
export function checkDriverRef(
  ref: DriverRef,
  expectedKind: DriverKind,
): Effect.Effect<void, UnknownDriver | DriverConfigRejected> {
  const registered = REGISTERED_DRIVERS[ref.name];
  if (registered === undefined || registered.kind !== expectedKind) {
    return Effect.fail(
      new UnknownDriver({
        name: ref.name,
        message: `No registered ${expectedKind} driver is named "${ref.name}". Registered ${expectedKind} drivers: ${registeredNames(expectedKind).join(", ")}.`,
      }),
    );
  }
  return decodeDriverConfig(ref, registered.config).pipe(Effect.asVoid);
}

/**
 * Refuse a traffic-tracking done-signal on a multi-step episode. On a
 * one-step spec the traffic and the schedule coincide: the only thing the
 * schedule waits for is the answer to that step. On a multi-step spec
 * they diverge, and a message counter or a span name can fire before a
 * later step is ever spoken, converting a probe into a run that proves
 * nothing while still producing a verdict.
 *
 * One clause suffices because a gated spec always has more than one step:
 * a gate on the first step is already refused, so "gated" is a subset of
 * "multi-step".
 */
export function checkDoneSignalShape(
  ref: DriverRef,
  multiStep: boolean,
): Effect.Effect<void, DoneSignalUnsafe> {
  if (!multiStep) return Effect.void;
  if (REGISTERED_DRIVERS[ref.name]?.tracksTraffic !== true) return Effect.void;
  return Effect.fail(
    new DoneSignalUnsafe({
      driver: ref.name,
      message: `Done-signal driver "${ref.name}" fires on society traffic, so on an episode with more than one step it can fire before a later step is spoken and seal a run that never reached the end of its schedule. Use "${LAST_STEP_ANSWERED_DONE_SIGNAL}", whose completion condition tracks the schedule instead of the traffic.`,
    }),
  );
}

function registeredNames(kind: DriverKind): ReadonlyArray<string> {
  return Object.entries(REGISTERED_DRIVERS)
    .filter(([, entry]) => entry.kind === kind)
    .map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Done-signal predicates
// ---------------------------------------------------------------------------

/** A stateful completion predicate; `observe` reports whether this event completes the episode. */
export type DonePredicate = {
  readonly driverName: string;
  observe(event: SimulatorEvent): boolean;
};

/** What a predicate needs to relate the spec's names to the identities on the wire. */
export type PredicateContext = {
  readonly agentIds: ReadonlyMap<string, AgentId>;
  readonly steps: ReadonlyArray<SpeechStep>;
};

/** Instantiate the done-signal predicate for one episode; the ref is already materialization-checked. */
export function makeDonePredicate(
  ref: DriverRef,
  context: PredicateContext,
): Effect.Effect<DonePredicate, UnknownDriver | DriverConfigRejected> {
  return checkDriverRef(ref, "done-signal").pipe(
    Effect.zipRight(donePredicateFor(ref, context)),
  );
}

function donePredicateFor(
  ref: DriverRef,
  context: PredicateContext,
): Effect.Effect<DonePredicate, DriverConfigRejected> {
  switch (ref.name) {
    case REPLIES_DONE_SIGNAL:
      return makeRepliesPredicate(ref, context);
    case LAST_STEP_ANSWERED_DONE_SIGNAL:
      return makeLastStepAnsweredPredicate(ref, context);
    default:
      return makeSpanNamePredicate(ref);
  }
}

function makeSpanNamePredicate(
  ref: DriverRef,
): Effect.Effect<DonePredicate, DriverConfigRejected> {
  return decodeDriverConfig(ref, SpanNameDoneConfig).pipe(
    Effect.map((config) =>
      countingPredicate(
        ref.name,
        config.minCount,
        (event) =>
          event._tag === "span.accepted" && event.spanName === config.name,
      ),
    ),
  );
}

/**
 * Counts the messages the named agent committed, read off the delivered
 * spans the server already emits. An agent's own name resolves to the id
 * the spans carry through the launch-time registration; an unlaunched
 * name cannot match, and materialization is what keeps that unreachable.
 */
function makeRepliesPredicate(
  ref: DriverRef,
  context: PredicateContext,
): Effect.Effect<DonePredicate, DriverConfigRejected> {
  return decodeDriverConfig(ref, RepliesDoneConfig).pipe(
    Effect.map((config) => {
      const senderId = context.agentIds.get(config.from);
      return countingPredicate(ref.name, config.minCount, (event) => {
        if (senderId === undefined) return false;
        if (event._tag !== "span.accepted") return false;
        if (event.spanName !== MESSAGE_DELIVERED_SPAN) return false;
        return readDeliveredMessage(event.raw)?.senderId === senderId;
      });
    }),
  );
}

/**
 * Done when the last scheduled step has been answered.
 *
 * It arms only on the last step's own `step.spoken`, which is what makes
 * it safe where the traffic-tracking predicates are not: before that
 * event exists there is no receipt to match against, so the predicate
 * cannot fire early and cannot cut the schedule short. Retention in the
 * delivered log means arming late still matches an answer whose span
 * arrived first.
 */
function makeLastStepAnsweredPredicate(
  ref: DriverRef,
  context: PredicateContext,
): Effect.Effect<DonePredicate, DriverConfigRejected> {
  return decodeDriverConfig(ref, LastStepAnsweredConfig).pipe(
    Effect.map((config) => {
      const delivered = makeDeliveredLog();
      const named = config.from;
      const senders =
        named === undefined
          ? participantSenders(context)
          : wireIdentities(context, [named]);
      let stepsSpoken = 0;
      let criteria: AnswerCriteria | undefined;
      return {
        driverName: ref.name,
        observe: (event: SimulatorEvent): boolean => {
          if (event._tag === "step.spoken") {
            stepsSpoken += 1;
            if (stepsSpoken === context.steps.length) {
              criteria = {
                conversationId: event.conversationId,
                afterMessageId: event.messageId,
                senders,
              };
            }
          } else if (event._tag === "span.accepted") {
            delivered.record(event.logicalSequence, event.spanName, event.raw);
          }
          return (
            criteria !== undefined && delivered.answer(criteria) !== undefined
          );
        },
      };
    }),
  );
}

/**
 * Every launched participant of the last step. The step's speaker is a
 * principal and never a launched agent, so resolving through the launched
 * agents excludes it.
 */
function participantSenders(context: PredicateContext): ReadonlySet<string> {
  return wireIdentities(context, lastStepParticipants(context.steps));
}

function wireIdentities(
  context: PredicateContext,
  names: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set(
    names.flatMap((name) => {
      const id = context.agentIds.get(name);
      return id === undefined ? [] : [id];
    }),
  );
}

/**
 * The participants of the conversation the last step spoke into. A `send`
 * step names no participants of its own, so the walk follows `into` back
 * to the step that started the task. Materialization requires every
 * `into` to name an earlier step, so the cursor strictly decreases.
 */
function lastStepParticipants(
  steps: ReadonlyArray<SpeechStep>,
): ReadonlyArray<string> {
  let cursor = steps.length - 1;
  while (cursor >= 0) {
    const step = steps[cursor];
    if (step?.with !== undefined) return step.with;
    const next = precedingStepIndex(steps, step, cursor);
    if (next === undefined) return [];
    cursor = next;
  }
  return [];
}

function precedingStepIndex(
  steps: ReadonlyArray<SpeechStep>,
  step: SpeechStep | undefined,
  cursor: number,
): number | undefined {
  const target = step?.into;
  if (target === undefined) return undefined;
  const next = steps.findIndex((candidate) => candidate.name === target);
  return next >= 0 && next < cursor ? next : undefined;
}

function countingPredicate(
  driverName: string,
  minCount: number,
  matches: (event: SimulatorEvent) => boolean,
): DonePredicate {
  let seen = 0;
  return {
    driverName,
    observe: (event: SimulatorEvent): boolean => {
      if (!matches(event)) return false;
      seen += 1;
      return seen >= minCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

function speechFailed(
  delivery: SpeechDelivery,
  phase: "open" | "speak",
  detail: string,
  channel?: ChannelRef,
): SpeechFailed {
  return new SpeechFailed({
    principal: delivery.step.by,
    phase,
    taskId: channel?.taskId,
    conversationId: channel?.conversationId,
    message: `Principal "${delivery.step.by}" could not speak: ${detail}`,
  });
}

function speechFailure(
  delivery: SpeechDelivery,
  phase: "open" | "speak",
  detail: string,
  channel?: ChannelRef,
): (cause: unknown) => Effect.Effect<never, SpeechFailed> {
  return (cause) =>
    Effect.fail(
      speechFailed(delivery, phase, `${detail}: ${String(cause)}`, channel),
    );
}

/**
 * Resolve one `with:` entry to the identity it will be invited as.
 * Agent and principal names share one namespace, so at most one side
 * answers; a principal participant is minted on first reference, which is
 * what lets a later step speak as it.
 */
function participantId(
  pool: PrincipalPool,
  delivery: SpeechDelivery,
  participant: AgentName | PrincipalName,
): Effect.Effect<AgentId, SpeechFailed> {
  const launched = delivery.world.agents.find(
    (agent) => agent.slot === participant,
  );
  if (launched !== undefined) return Effect.succeed(launched.agentId);
  return mintedIdentity(pool, delivery, participant).pipe(
    Effect.map((minted) => minted.agentId),
  );
}

/** Start a task with the step's participants alongside the speaker, then speak into its conversation. */
function startAndSpeak(
  pool: PrincipalPool,
  client: MoltZapAgentClient,
  delivery: SpeechDelivery,
  participants: ReadonlyArray<AgentName | PrincipalName>,
): Effect.Effect<SpeechReceipt, SpeechFailed> {
  return Effect.forEach(
    participants,
    (participant) => participantId(pool, delivery, participant),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((invited) =>
      client
        .callDefinition(TaskRequest, {
          appId: DEFAULT_APP_ID,
          invitedAgentIds: invited,
          initialConversation: { participants: invited },
        })
        .pipe(Effect.catchAll(speechFailure(delivery, "open", "task request"))),
    ),
    Effect.flatMap((created) =>
      created.conversation === null
        ? Effect.fail(
            speechFailed(
              delivery,
              "open",
              "the task request returned no initial conversation",
            ),
          )
        : speakInto(client, delivery, {
            taskId: created.task.id,
            conversationId: created.conversation.id,
          }),
    ),
  );
}

/** Send the step's text into an existing conversation and report where it landed. */
function speakInto(
  client: MoltZapAgentClient,
  delivery: SpeechDelivery,
  channel: ChannelRef,
): Effect.Effect<SpeechReceipt, SpeechFailed> {
  return client
    .callDefinition(MessagesSend, {
      taskId: channel.taskId,
      conversationId: channel.conversationId,
      parts: [{ type: "text", text: delivery.step.say }],
    })
    .pipe(
      Effect.catchAll(
        speechFailure(delivery, "speak", "message send", channel),
      ),
      Effect.map((sent) => ({ ...channel, messageId: sent.message.id })),
    );
}

/**
 * One connected identity per principal named in the episode. Identities
 * and their clients outlive a single step: a principal that speaks twice
 * must be the same identity both times (a second registration under the
 * same name would mint a second server identity and break the grader's
 * sender-to-name join), and a principal invited into a task must already
 * exist when the inviting step speaks.
 */
type PrincipalPool = {
  readonly secrets: Secrets;
  readonly identities: Map<string, MintedIdentity>;
  readonly clients: Map<string, MoltZapAgentClient>;
};

function mintedIdentity(
  pool: PrincipalPool,
  delivery: SpeechDelivery,
  name: AgentName | PrincipalName,
): Effect.Effect<MintedIdentity, SpeechFailed> {
  const cached = pool.identities.get(name);
  if (cached !== undefined) return Effect.succeed(cached);
  return registerIdentity({
    httpBase: httpBaseFromServerUrl(delivery.world.server.serverUrl),
    name,
  }).pipe(
    Effect.catchTag("IdentityRegistrationFailed", (cause) =>
      Effect.fail(speechFailed(delivery, "open", cause.message)),
    ),
    Effect.tap((minted) =>
      Effect.sync(() => {
        pool.secrets.register(agentKeyValue(minted.apiKey));
        pool.identities.set(name, minted);
      }),
    ),
  );
}

function connectedClient(
  pool: PrincipalPool,
  delivery: SpeechDelivery,
): Effect.Effect<MoltZapAgentClient, SpeechFailed> {
  const speaker = delivery.step.by;
  const cached = pool.clients.get(speaker);
  if (cached !== undefined) return Effect.succeed(cached);
  return mintedIdentity(pool, delivery, speaker).pipe(
    Effect.flatMap((minted) => {
      const client = new MoltZapAgentClient({
        serverUrl: delivery.world.server.serverUrl,
        agentKey: minted.apiKey,
      });
      return client.connect().pipe(
        Effect.catchAll(speechFailure(delivery, "open", "principal connect")),
        Effect.as(client),
        Effect.tap(() =>
          Effect.sync(() => {
            pool.clients.set(speaker, client);
          }),
        ),
      );
    }),
  );
}

function speakOneStep(
  pool: PrincipalPool,
  client: MoltZapAgentClient,
  delivery: SpeechDelivery,
): Effect.Effect<SpeechReceipt, SpeechFailed> {
  if (delivery.into !== undefined) {
    return speakInto(client, delivery, delivery.into);
  }
  const participants = delivery.step.with;
  if (participants === undefined) {
    // Materialization requires exactly one of `with`/`into`; reaching here is a defect.
    return Effect.dieMessage(
      "a step with neither `with` nor `into` escaped materialization",
    );
  }
  return startAndSpeak(pool, client, delivery, participants);
}

/**
 * The v0 out-of-band principal: registers each principal's own agent
 * identity against the run's server and speaks as that identity — so
 * speech is attributed to a principal identity in the conversation flow,
 * never a system sender. Minted keys are registered in the per-attempt
 * `Secrets` before any protocol traffic carries them.
 */
function makeOutOfBandPrincipal(pool: PrincipalPool): Principal {
  return {
    deliver: (delivery: SpeechDelivery) =>
      connectedClient(pool, delivery).pipe(
        Effect.flatMap((client) => speakOneStep(pool, client, delivery)),
        Effect.withSpan("Principal.deliver"),
      ),
  };
}

/**
 * Instantiate the principal for one episode; absent ref means the default
 * out-of-band principal. The pool's clients close when the run's scope
 * does, so the principals stay reachable for every step of the episode.
 */
export function makePrincipal(
  ref: DriverRef | undefined,
  context: { readonly secrets: Secrets },
): Effect.Effect<Principal, UnknownDriver | DriverConfigRejected, Scope.Scope> {
  return Effect.gen(function* () {
    if (ref !== undefined) yield* checkDriverRef(ref, "principal");
    const pool: PrincipalPool = {
      secrets: context.secrets,
      identities: new Map(),
      clients: new Map(),
    };
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...pool.clients.values()], (client) => client.close(), {
        concurrency: 1,
        discard: true,
      }),
    );
    return makeOutOfBandPrincipal(pool);
  }).pipe(Effect.withSpan("makePrincipal"));
}

/** The agent-name to wire-identity map every predicate resolves names through. */
export function agentIdsOf(society: Society): ReadonlyMap<string, AgentId> {
  return new Map(society.agents.map((agent) => [agent.slot, agent.agentId]));
}
