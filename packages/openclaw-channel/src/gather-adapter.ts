/**
 * @file Binds the gather overlay to one OpenClaw account.
 *
 * A model reaches the overlay through the stock `message` tool by writing a
 * JSON document as the message text. The send callback starts the gather and
 * returns at once: the inbound loop handles one delivery at a time and awaits
 * the whole model turn, so a tool call that waited for contributions would
 * hold up the loop that delivers them. The result arrives later as one turn.
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
  InboundMessage,
  type SendError,
  type SendInput,
} from "@moltzap/client";
import { Clock, Config, Effect, Option, Schema, type Scope } from "effect";
import { randomBytes } from "node:crypto";

import {
  type DeliveryDisposition,
  type GatherInputError,
  type GatherResult,
  makeGatherOverlay,
} from "./gather-overlay.js";

const MILLIS_PER_SECOND = 1_000;
const CODE_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/u;

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
const decodeMessage = Schema.decodeUnknownOption(InboundMessage);

type Command = typeof gatherCommand.Type | typeof contributionCommand.Type;

/** Counts of what models wrote, for the smoke report. */
export interface GatherAdapterCounters {
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
  ) => Option.Option<Effect.Effect<void, SendError | GatherInputError>>;
  readonly counters: Effect.Effect<GatherAdapterCounters>;
}

/** What the adapter needs from the account connection that owns it. */
export interface GatherAdapterOptions {
  readonly send: HarnessEndpoint["send"];
  /** Run one host turn whose text is `message.content`. */
  readonly runTurn: (message: InboundMessage) => Effect.Effect<void>;
  readonly log: (line: string) => void;
}

function parseCommand(text: string): Option.Option<Command> {
  const trimmed = text.trim();
  const fenced = CODE_FENCE.exec(trimmed);
  return decodeCommand(fenced?.[1] ?? trimmed);
}

function memberAddress(member: string): Option.Option<AgentAddress> {
  return decodeAddress(
    member.startsWith("agent:") ? member : `agent:${member}`,
  );
}

function textOf(content: Content): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function describeContributions(
  contributions: ReadonlyMap<AgentAddress, Content>,
): string {
  return [...contributions]
    .map(([member, content]) => `- ${member}: ${textOf(content)}`)
    .join("\n");
}

function describeResult(result: GatherResult): string {
  const missing =
    result.missing.length === 0 ? "none" : result.missing.join(", ");
  return [
    `Gather ${result.id} finished. These are all the answers; no further replies are coming for it.`,
    describeContributions(result.contributions),
    `No answer from: ${missing}.`,
  ].join("\n");
}

/**
 * A result turn needs an inbound message for the host's routing facts. The
 * last accepted contribution supplies real ones; a gather nobody answered has
 * none, so the first member stands in.
 */
function resultCarrier(
  result: GatherResult,
  firstMember: AgentAddress,
): Option.Option<InboundMessage> {
  const text: Content = [{ type: "text", text: describeResult(result) }];
  return Option.match(result.lastAccepted, {
    onSome: (carrier) => Option.some({ ...carrier, content: text }),
    onNone: () =>
      decodeMessage({
        kind: "direct",
        postId: `pst_${randomBytes(32).toString("base64url")}`,
        address: firstMember,
        sender: firstMember,
        content: text,
      }),
  });
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
    const scope = yield* Effect.scope;
    const counts = {
      gathersStarted: 0,
      contributionsSent: 0,
      unknownMembers: 0,
    };
    const overlay = yield* makeGatherOverlay({
      self: self.value,
      send: options.send,
      withholdPeerContributions: true,
      onMemberResult: (listed, close) =>
        options.runTurn({
          ...close,
          content: [
            {
              type: "text",
              text: `The gather closed. Every member holds these same answers:\n${describeContributions(listed)}`,
            },
          ],
        }),
    });

    function startGather(
      command: typeof gatherCommand.Type,
    ): Effect.Effect<void, GatherInputError> {
      return Effect.gen(function* () {
        const members = command.gather.members.flatMap((member) =>
          Option.toArray(memberAddress(member)),
        );
        counts.unknownMembers += command.gather.members.length - members.length;
        const now = yield* Clock.currentTimeMillis;
        const request = {
          members,
          prompt: command.message,
          deadlineAt: now + command.gather.deadlineSeconds * MILLIS_PER_SECOND,
          topology: command.gather.topology,
        };
        counts.gathersStarted += 1;
        options.log(
          `MoltZap gather: start ${request.topology} to ${members.join(",")}`,
        );
        yield* overlay.gather(request).pipe(
          Effect.flatMap((result) => {
            options.log(
              `MoltZap gather: ${result.id} done got=${result.contributions.size} missing=${result.missing.length} closeCertified=${result.closeCertified}`,
            );
            const first = members[0];
            return first === undefined
              ? Effect.void
              : Option.match(resultCarrier(result, first), {
                  onNone: () => Effect.void,
                  onSome: options.runTurn,
                });
          }),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              options.log(`MoltZap gather: rejected ${error.reason}`);
            }),
          ),
          Effect.forkIn(scope),
        );
      });
    }

    const adapter: GatherAdapter = {
      onDelivery: overlay.onDelivery,
      commandSend: (to, text) =>
        Option.map(parseCommand(text), (command) => {
          if ("gather" in command) {
            return startGather(command);
          }
          counts.contributionsSent += 1;
          return overlay.contribute(
            command.contribution.id,
            to,
            command.message,
          );
        }),
      counters: Effect.sync(() => ({ ...counts })),
    };
    return Option.some(adapter);
  });
}
