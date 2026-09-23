/**
 * @file Binds the gather overlay to one OpenClaw account.
 *
 * A model reaches the overlay through the stock `message` tool by writing a
 * JSON document as the message text. The send callback returns once the
 * gather's requests are out, and fails when a member cannot be reached so the
 * model can correct the member list. It does not wait for contributions: the
 * inbound loop handles one delivery at a time and awaits the whole model turn,
 * so a tool call that waited for them would hold up the loop that delivers
 * them. The result arrives later as one turn.
 *
 * That turn, and a shared-gather member's turn at the close, is a
 * {@link GatherReport}: the gather speaking for itself, not a post. It comes
 * from the local agent's own address and carries an identity derived from the
 * gather id, so the model never reads it as one member's answer and no
 * member's conversation history matches it.
 *
 * The adapter is off unless `MOLTZAP_AGENT_NAME` names the local agent, which
 * the overlay needs for group addresses and reply targets. With it unset every
 * send and delivery takes the ordinary path, which is the baseline arm.
 */

import {
  AgentAddress,
  type Content,
  type HarnessEndpoint,
  type InboundDelivery,
  type SendError,
  type SendInput,
} from "@moltzap/client";
import { Clock, Config, Effect, Option, Schema, type Scope } from "effect";

import {
  type DeliveryDisposition,
  type GatherInputError,
  type GatherOverlay,
  type GatherResult,
  GatherStartError,
  makeGatherOverlay,
} from "./gather-overlay.js";

const MILLIS_PER_SECOND = 1_000;
/** Tells the model a report is the gather's own, not any one person's post. */
const REPORT_ATTRIBUTION =
  "collected by the MoltZap gather, not a message from any one person";
const CODE_FENCE = "```";
const JSON_INFO_STRING = "json";

const gatherCommand = Schema.Struct({
  gather: Schema.Struct({
    members: Schema.NonEmptyArray(Schema.String),
    deadlineSeconds: Schema.Number.pipe(Schema.positive()),
    topology: Schema.Literal("pairwise", "shared"),
  }),
  message: Schema.String,
});
const contributionCommand = Schema.Struct({
  contribution: Schema.Struct({ id: Schema.String }),
  message: Schema.String,
});
const decodeCommand = Schema.decodeUnknownOption(
  Schema.parseJson(Schema.Union(gatherCommand, contributionCommand)),
);
const decodeAddress = Schema.decodeUnknownOption(AgentAddress);

type GatherCommand = typeof gatherCommand.Type;
type Command = GatherCommand | typeof contributionCommand.Type;

/** Counts of what models wrote, for the smoke report. */
interface GatherAdapterCounters {
  readonly gathersStarted: number;
  readonly contributionsSent: number;
  readonly unknownMembers: number;
}

/** Gather behavior for one connected account. */
export interface GatherAdapter {
  readonly onDelivery: (
    delivery: InboundDelivery,
  ) => Effect.Effect<DeliveryDisposition>;
  /** The send to perform for `text` when it is a gather document. */
  readonly commandSend: (
    to: SendInput["to"],
    text: string,
  ) => Option.Option<
    Effect.Effect<void, SendError | GatherInputError | GatherStartError>
  >;
  readonly counters: Effect.Effect<GatherAdapterCounters>;
}

/**
 * One host turn in which the gather reports to the local model. `from` is the
 * local agent, never a member. `turnId` joins `gather`, the gather id and the
 * stage with colons: fixed for one gather and stage, so a replayed report
 * carries the same identity, and never a canonical Router post id, which
 * always starts `pst_`.
 */
export interface GatherReport {
  readonly turnId: string;
  readonly from: AgentAddress;
  readonly text: string;
}

/** What the adapter needs from the account connection that owns it. */
export interface GatherAdapterOptions {
  readonly send: HarnessEndpoint["send"];
  readonly runTurn: (report: GatherReport) => Effect.Effect<void>;
  readonly log: (line: string) => void;
}

/** One account's adapter state. Gathers fork into `scope`. */
interface AdapterState {
  readonly options: GatherAdapterOptions;
  readonly self: AgentAddress;
  readonly scope: Scope.Scope;
  readonly overlay: GatherOverlay;
  readonly counts: { -readonly [Key in keyof GatherAdapterCounters]: number };
}

/**
 * Build the adapter, or nothing when the local agent name is not configured.
 * Gathers run in the surrounding scope, so closing the account connection
 * interrupts any that are still open.
 */
export function makeGatherAdapter(
  options: GatherAdapterOptions,
): Effect.Effect<Option.Option<GatherAdapter>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const configured = yield* Config.string("MOLTZAP_AGENT_NAME").pipe(
      Effect.option,
    );
    const self = Option.flatMap(configured, memberAddress);
    if (Option.isNone(self)) {
      options.log("MoltZap gather: off (MOLTZAP_AGENT_NAME is not set)");
      return Option.none();
    }
    const state = yield* adapterState(options, self.value);
    return Option.some(adapterFor(state));
  }).pipe(Effect.withSpan("makeGatherAdapter"));
}

function adapterState(
  options: GatherAdapterOptions,
  self: AgentAddress,
): Effect.Effect<AdapterState, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const overlay = yield* makeGatherOverlay({
      self,
      send: options.send,
      withholdPeerContributions: true,
      onMemberResult: (id, initiator, listed) =>
        options.runTurn(memberReport(self, id, initiator, listed)),
    });
    return {
      options,
      self,
      scope,
      overlay,
      counts: { gathersStarted: 0, contributionsSent: 0, unknownMembers: 0 },
    };
  });
}

function memberReport(
  self: AgentAddress,
  id: string,
  initiator: AgentAddress,
  listed: ReadonlyMap<AgentAddress, Content>,
): GatherReport {
  return {
    turnId: `gather:${id}:close`,
    from: self,
    text: [
      `Gather ${id} from ${initiator} closed (${REPORT_ATTRIBUTION}). Every member holds these same answers:`,
      describeContributions(listed),
    ].join("\n"),
  };
}

function adapterFor(state: AdapterState): GatherAdapter {
  return {
    onDelivery: state.overlay.onDelivery,
    commandSend: (to, text) =>
      Option.map(parseCommand(text), (command) =>
        runCommand(state, to, command),
      ),
    counters: Effect.sync(() => ({ ...state.counts })),
  };
}

function parseCommand(text: string): Option.Option<Command> {
  return decodeCommand(unfence(text.trim()));
}

/**
 * The body of a Markdown code fence with an optional `json` info string, or
 * `text` itself when it is not fenced. Prefix and suffix checks keep the scan
 * linear in the length of model-written text.
 */
function unfence(text: string): string {
  const fenced =
    text.length >= 2 * CODE_FENCE.length &&
    text.startsWith(CODE_FENCE) &&
    text.endsWith(CODE_FENCE);
  if (!fenced) {
    return text;
  }
  const body = text.slice(CODE_FENCE.length, -CODE_FENCE.length);
  const unlabeled = body.startsWith(JSON_INFO_STRING)
    ? body.slice(JSON_INFO_STRING.length)
    : body;
  return unlabeled.trim();
}

/** Counts a contribution when the model writes it, before the send runs. */
function runCommand(
  state: AdapterState,
  to: SendInput["to"],
  command: Command,
): Effect.Effect<void, SendError | GatherInputError | GatherStartError> {
  if ("gather" in command) {
    return startGather(state, command);
  }
  state.counts.contributionsSent += 1;
  return state.overlay.contribute(command.contribution.id, to, command.message);
}

/**
 * A member name that is not an agent address fails the command before any
 * request goes out, as does an unusable member list or an unreachable member.
 */
function startGather(
  state: AdapterState,
  command: GatherCommand,
): Effect.Effect<void, GatherInputError | GatherStartError> {
  return Effect.gen(function* () {
    const members = yield* memberAddresses(state, command.gather.members);
    const now = yield* Clock.currentTimeMillis;
    const request = {
      members,
      prompt: command.message,
      deadlineAt: now + command.gather.deadlineSeconds * MILLIS_PER_SECOND,
      topology: command.gather.topology,
    };
    state.options.log(
      `MoltZap gather: start ${request.topology} to ${members.join(",")}`,
    );
    const started = yield* state.overlay.start(request).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          state.options.log(`MoltZap gather: not started: ${error.message}`);
        }),
      ),
    );
    state.counts.gathersStarted += 1;
    yield* started.result.pipe(
      Effect.flatMap((result) => reportResult(state, result)),
      Effect.forkIn(state.scope),
    );
  });
}

function memberAddresses(
  state: AdapterState,
  names: readonly string[],
): Effect.Effect<readonly AgentAddress[], GatherStartError> {
  const unknown = names.filter((name) => Option.isNone(memberAddress(name)));
  if (unknown.length > 0) {
    state.counts.unknownMembers += unknown.length;
    return Effect.fail(
      new GatherStartError({
        failures: unknown.map((member) => ({
          member,
          reason: "invalid-address",
        })),
      }),
    );
  }
  return Effect.succeed(
    names.flatMap((name) => Option.toArray(memberAddress(name))),
  );
}

function memberAddress(member: string): Option.Option<AgentAddress> {
  return decodeAddress(
    member.startsWith("agent:") ? member : `agent:${member}`,
  );
}

function reportResult(
  state: AdapterState,
  result: GatherResult,
): Effect.Effect<void> {
  state.options.log(
    `MoltZap gather: ${result.id} done got=${result.contributions.size} missing=${result.missing.length} closeCertified=${result.closeCertified}`,
  );
  return state.options.runTurn({
    turnId: `gather:${result.id}:result`,
    from: state.self,
    text: describeResult(result),
  });
}

function describeResult(result: GatherResult): string {
  const missing =
    result.missing.length === 0 ? "none" : result.missing.join(", ");
  return [
    `Gather ${result.id} result (${REPORT_ATTRIBUTION}):`,
    describeContributions(result.contributions),
    `No answer from: ${missing}.`,
    "These are all the answers; no further replies are coming for it.",
  ].join("\n");
}

function describeContributions(
  contributions: ReadonlyMap<AgentAddress, Content>,
): string {
  if (contributions.size === 0) {
    return "- no answers";
  }
  return [...contributions]
    .map(([member, content]) => `- ${member}: ${textOf(content)}`)
    .join("\n");
}

function textOf(content: Content): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}
