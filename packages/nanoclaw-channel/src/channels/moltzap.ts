/** @file Projects the public MoltZap endpoint capability into NanoClaw. */
import {
  acquireHarnessEndpoint,
  type CollectiveError,
  type ConnectError,
  type Content,
  type ContentPart,
  type DeliveryAcknowledgeError,
  type HarnessEndpoint,
  type InboundDelivery,
  type InboundItem,
  MessageAddressInput,
  type InboundMessage as MoltZapInboundMessage,
  parseMessageText,
  type SendError,
  type SendInput,
  type SendResult,
} from "@moltzap/client";
import {
  Config,
  ConfigProvider,
  Data,
  Deferred,
  Effect,
  Either,
  Exit,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { absurd } from "effect/Function";
import { randomUUID } from "node:crypto";
import type { ChannelSetup, InboundMessage } from "./adapter.js";
import { registerChannelAdapter } from "./channel-registry.js";

/* eslint-disable jsdoc/text-escaping -- Mermaid sequenceDiagram blocks require literal HTML5 `<br>` separators. */
/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- NanoClaw's mirrored ChannelAdapter lifecycle is Promise-based. */

/** A NanoClaw host value cannot cross the addressed Client boundary. */
class MoltZapChannelError extends Data.TaggedError("MoltZapChannelError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const MOLTZAP_CHANNEL = "moltzap";
const NANOCLAW_MAIN_CHANNEL = "cli";
const NANOCLAW_MAIN_PLATFORM_ID = "local";
const MOLTZAP_CHANNEL_DEFAULTS = Object.freeze({
  dm: {
    engageMode: "pattern" as const,
    engagePattern: ".",
    threads: false,
    unknownSenderPolicy: "public" as const,
  },
  group: {
    engageMode: "pattern" as const,
    engagePattern: ".",
    threads: false,
    unknownSenderPolicy: "public" as const,
  },
  mentions: "platform" as const,
});

/**
 * Client exposes no post time, so a fixed placeholder keeps replay payloads
 * identical.
 */
const MOLTZAP_INBOUND_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const moltZapChannelEnv = Config.all({
  mcpEndpoint: Config.option(Config.string("MOLTZAP_MCP_URL")).pipe(
    Config.map(Option.getOrNull),
  ),
});

interface MoltZapActivation {
  readonly endpoint: HarnessEndpoint;
  readonly finished: Deferred.Deferred<undefined>;
  readonly scope: Scope.CloseableScope;
  readonly stopSignal: Deferred.Deferred<undefined>;
  state: "active" | "stopping";
}

interface MoltZapOutboundFile {
  readonly filename: string;
  readonly data: Uint8Array;
}

interface MoltZapOutboundMessage {
  readonly kind: string;
  readonly content: unknown;
  readonly files?: readonly MoltZapOutboundFile[];
}

/** One outbound row's address and text, ready for the Client's parser. */
interface OutboundText {
  readonly to: MessageAddressInput;
  readonly text: string;
}

/**
 * Read one outbound row's address and text. The text is parsed separately,
 * so a refused operation text can reach the model rather than fail the row.
 */
function decodeOutboundText(
  address: string,
  message: MoltZapOutboundMessage,
): Effect.Effect<OutboundText, MoltZapChannelError> {
  return decodeOutboundOperation(message).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknown(MessageAddressInput)(address).pipe(
        Effect.map((to) => ({ to, text })),
      ),
    ),
    Effect.catchTag("ParseError", () =>
      Effect.fail(
        new MoltZapChannelError({
          reason:
            "MoltZap outbound delivery requires an explicit agent or group address",
        }),
      ),
    ),
  );
}

function decodeOutboundOperation(
  message: MoltZapOutboundMessage,
): Effect.Effect<string, MoltZapChannelError> {
  if (message.kind !== "chat") {
    return Effect.fail(
      new MoltZapChannelError({
        reason: "MoltZap outbound messages must use NanoClaw chat delivery",
      }),
    );
  }
  if (message.files !== undefined && message.files.length > 0) {
    return Effect.fail(
      new MoltZapChannelError({
        reason: "MoltZap outbound messages do not accept native files",
      }),
    );
  }
  const text = extractOutboundText(message);
  return text === null
    ? Effect.fail(
        new MoltZapChannelError({
          reason: "MoltZap outbound messages require text content",
        }),
      )
    : Effect.succeed(text);
}

/**
 * Read the text from NanoClaw's `messages_out` content: a bare string, or the
 * `text` of the object `send_message` writes.
 * @param message One outbound row as NanoClaw delivers it.
 * @returns The text, or null when the row carries none.
 */
function extractOutboundText(message: MoltZapOutboundMessage): string | null {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (content === null || typeof content !== "object") {
    return null;
  }
  return "text" in content && typeof content.text === "string"
    ? content.text
    : null;
}

/**
 * Every send but a multicast has an operation id, so its refusal can
 * arrive later as an `operationFailed` item. NanoClaw's `send_message` has
 * already returned when the adapter sends, so those failures take that path
 * and the delivery completes; the host never retries a refused one. A
 * multicast failure still fails the delivery, leaving retry to NanoClaw.
 */
function failureDeliveryOf(input: SendInput): "result" | "inbound" {
  return "collectiveResponse" in input ||
    (input.collective?.op ?? "multicast") !== "multicast"
    ? "inbound"
    : "result";
}

function renderContent(content: Content): string {
  return content.map((part) => renderContentPart(part)).join("\n");
}

function renderContentPart(part: ContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "data":
      return JSON.stringify(part.value);
    default: {
      const exhaustivePart: never = part;
      return exhaustivePart;
    }
  }
}

/** The sender NanoClaw records for an item the endpoint itself emitted. */
const ENDPOINT_SENDER = "MoltZap";

type CollectiveRequestItem = Extract<
  InboundItem,
  { readonly kind: "collectiveRequest" }
>;
type CollectiveResultItem = Extract<
  InboundItem,
  { readonly kind: "collectiveResult" }
>;
type MemberOutcome = CollectiveResultItem["outcomes"][number]["outcome"];

/**
 * A request message: the question, its form, and the exact text that answers
 * it through `send_message`, addressed to the conversation the request
 * arrived in, the requester's for a gather and the group's for an
 * all_gather.
 */
function renderCollectiveRequest(item: CollectiveRequestItem): string {
  const deadline = new Date(item.deadlineAt).toISOString();
  const asked = item.to.startsWith("group:")
    ? `all_gather from ${item.from} to ${item.to}`
    : `gather from ${item.from}`;
  return [
    `${asked}, open until ${deadline}.`,
    `Question: ${item.question}`,
    `Form: ${JSON.stringify(item.requestedSchema)}`,
    'Answer with: {"action":"accept","content":{...}} where content matches the form, or {"action":"decline"}',
    `Send the answer once as the whole text of send_message to ${item.to}.`,
  ].join("\n");
}

/** A result message; only an all_gather's result names a close post. */
function renderCollectiveResult(item: CollectiveResultItem): string {
  const operation = item.closePostId === undefined ? "gather" : "all_gather";
  return [
    `${operation} result for the question sent to ${item.to}: ${item.question}`,
    ...item.outcomes.map(
      ({ member, outcome }) => `- ${member}: ${renderOutcome(outcome)}`,
    ),
  ].join("\n");
}

/**
 * The members a gather has not reached yet: refused ones end as no answer,
 * and pending ones are asked once their post is certified.
 */
function renderReach({
  operationId,
  unreachable,
  pending,
}: SendResult): string {
  return [
    `gather ${String(operationId)} is asking the members it reached.`,
    ...(unreachable === undefined
      ? []
      : [
          `Could not reach ${unreachable
            .map(({ member, reason }) => `${member} (${reason})`)
            .join(", ")}; each ends as no answer.`,
        ]),
    ...(pending === undefined
      ? []
      : [
          `Still delivering to ${pending.join(", ")}; each is asked once delivered, or ends as no answer at the deadline.`,
        ]),
  ].join(" ");
}

function renderOutcome(outcome: MemberOutcome): string {
  switch (outcome.kind) {
    case "answered":
      return `answered ${JSON.stringify(outcome.content)}`;
    case "declined":
      return "declined";
    case "invalid":
      return `answered outside the form (${outcome.reason})`;
    case "no-answer":
      return "no answer";
    default:
      return absurd(outcome);
  }
}

/**
 * NanoClaw's inbox shape for a request, result or failure. A group address
 * keeps the native group flag and lists its members.
 */
function endpointInbound(input: {
  readonly id: string;
  readonly address: string;
  readonly sender: string;
  readonly text: string;
}): InboundMessage {
  const isGroup = input.address.startsWith("group:");
  return {
    id: input.id,
    kind: "chat",
    timestamp: MOLTZAP_INBOUND_TIMESTAMP,
    isMention: true,
    content: {
      text: input.text,
      address: input.address,
      sender: input.sender,
      senderId: input.sender,
      ...(isGroup
        ? {
            members: input.address
              .slice("group:".length)
              .split(",")
              .map((name) => `agent:${name}`),
          }
        : {}),
    },
    isGroup,
  };
}

/**
 * NanoClaw adapter backed by exactly one scoped `HarnessEndpoint`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Client as HarnessEndpoint
 *   participant Adapter as MoltZapChannelAdapter
 *   participant Host as NanoClaw host
 *   Client->>Adapter: InboundDelivery<br>multicast, request, result or failure
 *   Adapter->>Host: onMetadata<br>address and group shape
 *   Adapter->>Host: await onInboundEvent<br>main session and MoltZap reply route
 *   Adapter->>Client: acknowledge delivery
 *   Host->>Adapter: deliver<br>address and text
 *   Adapter->>Adapter: parse the text as a multicast, gather, all_gather or answer
 *   Adapter->>Client: send, a gather, all_gather or answer reporting failures inbound
 * ```
 *
 * The stream acknowledges after the stock host callback completes.
 */
class MoltZapChannelAdapter {
  readonly name = MOLTZAP_CHANNEL;
  readonly channelType = MOLTZAP_CHANNEL;
  readonly supportsThreads = false;

  private readonly lifecycleGate = Effect.runSync(Effect.makeSemaphore(1));
  private readonly mcpEndpoint: string;
  private activation: MoltZapActivation | null = null;
  private setupConfig: ChannelSetup | null = null;

  constructor(mcpEndpoint: string) {
    this.mcpEndpoint = mcpEndpoint;
  }

  // #ignore-sloppy-code-next-line[promise-type]: NanoClaw's ChannelAdapter lifecycle is Promise-native at the host boundary.
  setup(config: ChannelSetup): Promise<void> {
    return Effect.runPromise(
      this.lifecycleGate.withPermits(1)(
        Effect.suspend(() => this.start(config)),
      ),
    );
  }

  // #ignore-sloppy-code-next-line[promise-type]: NanoClaw's ChannelAdapter lifecycle is Promise-native at the host boundary.
  teardown(): Promise<void> {
    return Effect.runPromise(
      this.lifecycleGate.withPermits(1)(Effect.suspend(() => this.stop())),
    );
  }

  isConnected(): boolean {
    return this.activation?.state === "active";
  }

  deliver(
    platformId: string,
    ...args: [threadId: string | null, message: MoltZapOutboundMessage]
    // #ignore-sloppy-code-next-line[promise-type]: NanoClaw's ChannelAdapter delivery contract is Promise-native at the host boundary.
  ): Promise<string | undefined> {
    return Effect.runPromise(
      this.deliverEffect(platformId, args[1]).pipe(Effect.as(undefined)),
    );
  }

  private start(
    config: ChannelSetup,
  ): Effect.Effect<void, ConnectError | MoltZapChannelError> {
    const current = this.activation;
    if (current?.state === "active") {
      this.setupConfig = config;
      return Effect.void;
    }
    if (current?.state === "stopping") {
      return Deferred.await(current.finished).pipe(
        Effect.zipRight(Effect.suspend(() => this.start(config))),
      );
    }
    return Effect.gen(
      function* (this: MoltZapChannelAdapter) {
        const scope = yield* Scope.make();
        const endpoint = yield* this.acquireEndpoint(scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        const activation: MoltZapActivation = {
          endpoint,
          finished: yield* Deferred.make<undefined>(),
          scope,
          state: "active",
          stopSignal: yield* Deferred.make<undefined>(),
        };
        this.setupConfig = config;
        this.activation = activation;
        yield* endpoint.messages.pipe(
          Stream.onDone(() => this.beginStopping(activation)),
          Stream.onError(() => this.beginStopping(activation)),
          Stream.runForEach((delivery) => this.handleDelivery(delivery)),
          Effect.raceFirst(Deferred.await(activation.stopSignal)),
          Effect.ensuring(this.finishActivation(activation)),
          Effect.forkDaemon,
        );
      }.bind(this),
    ).pipe(Effect.asVoid);
  }

  private stop(): Effect.Effect<void> {
    const activation = this.activation;
    return activation === null
      ? Effect.void
      : this.beginStopping(activation).pipe(
          Effect.zipRight(Deferred.succeed(activation.stopSignal, undefined)),
          Effect.zipRight(Deferred.await(activation.finished)),
        );
  }

  private finishActivation(activation: MoltZapActivation): Effect.Effect<void> {
    return this.beginStopping(activation).pipe(
      Effect.zipRight(Scope.close(activation.scope, Exit.void)),
      Effect.zipRight(
        Effect.sync(() => {
          if (this.activation === activation) {
            this.activation = null;
            this.setupConfig = null;
          }
        }),
      ),
      Effect.ensuring(Deferred.succeed(activation.finished, undefined)),
      Effect.asVoid,
    );
  }

  private beginStopping(activation: MoltZapActivation): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.activation === activation) {
        activation.state = "stopping";
        this.setupConfig = null;
      }
    });
  }

  private acquireEndpoint(
    scope: Scope.CloseableScope,
  ): Effect.Effect<HarnessEndpoint, ConnectError | MoltZapChannelError> {
    return Effect.try({
      try: () => new URL(this.mcpEndpoint),
      catch: () =>
        new MoltZapChannelError({
          reason: "MoltZap channel MCP endpoint is invalid",
        }),
    }).pipe(Effect.flatMap(acquireHarnessEndpoint), Scope.extend(scope));
  }

  private deliverEffect(
    address: string,
    message: MoltZapOutboundMessage,
  ): Effect.Effect<void, MoltZapChannelError | SendError | CollectiveError> {
    const activation = this.activation;
    if (activation?.state !== "active") {
      return Effect.fail(
        new MoltZapChannelError({
          reason: "MoltZap channel is not connected",
        }),
      );
    }
    return decodeOutboundText(address, message).pipe(
      Effect.flatMap(
        ({
          to,
          text,
        }): Effect.Effect<
          void,
          MoltZapChannelError | SendError | CollectiveError
        > =>
          Either.match(parseMessageText(to, text), {
            onLeft: (error) => this.reportToModel(to, error.message),
            onRight: (input) =>
              activation.endpoint
                .send(input, { failureDelivery: failureDeliveryOf(input) })
                .pipe(
                  Effect.flatMap((result) =>
                    result.unreachable === undefined &&
                    result.pending === undefined
                      ? Effect.void
                      : this.reportToModel(to, renderReach(result)),
                  ),
                ),
          }),
      ),
    );
  }

  /**
   * Tell the model, in the conversation it sent to, what became of a send
   * whose `send_message` call has already returned: a refused operation text
   * with each failing field, or the members a gather could not reach. A
   * refused text completes its row, since NanoClaw retrying the same text
   * would fail the same way.
   * @param to The conversation the text was sent to.
   * @param report What the model needs to know.
   * @returns Completion after the host callback completed.
   */
  private reportToModel(
    to: MessageAddressInput,
    report: string,
  ): Effect.Effect<void, MoltZapChannelError> {
    const config = this.setupConfig;
    return config === null
      ? Effect.fail(new MoltZapChannelError({ reason: report }))
      : this.handToHost(
          config,
          to,
          endpointInbound({
            id: `report:${randomUUID()}`,
            address: to,
            sender: ENDPOINT_SENDER,
            text: `MoltZap: ${report}`,
          }),
        );
  }

  private handleDelivery(
    delivery: InboundDelivery,
  ): Effect.Effect<void, MoltZapChannelError | DeliveryAcknowledgeError> {
    const config = this.setupConfig;
    if (config === null) {
      return Effect.void;
    }
    return this.handleItem(config, delivery.item).pipe(
      Effect.zipRight(delivery.acknowledge),
    );
  }

  /**
   * Hand one item to NanoClaw's main session with a MoltZap reply route, in
   * the one fixed form its kind defines. A multicast keeps its message; a
   * request is a message from the requester in the conversation it arrived
   * in, direct for a gather and the group for an all_gather; a result or a failure is
   * attributed to MoltZap and routed to the address its operation named.
   * @param config The host callbacks from the active setup.
   * @param item The item the endpoint delivered.
   * @returns Completion after the host callback completed.
   */
  private handleItem(
    config: ChannelSetup,
    item: InboundItem,
  ): Effect.Effect<void, MoltZapChannelError> {
    switch (item.kind) {
      case "multicast":
        return this.handToHost(
          config,
          item.message.address,
          this.toInboundMessage(item.message),
        );
      case "collectiveRequest":
        return this.handToHost(
          config,
          item.to,
          endpointInbound({
            id: item.postId,
            address: item.to,
            sender: item.from,
            text: renderCollectiveRequest(item),
          }),
        );
      case "collectiveResult":
        return this.handToHost(
          config,
          item.to,
          endpointInbound({
            id: `${item.id}:result`,
            address: item.to,
            sender: ENDPOINT_SENDER,
            text: renderCollectiveResult(item),
          }),
        );
      case "operationFailed":
        return this.handToHost(
          config,
          item.to,
          endpointInbound({
            id: `${item.id}:failed`,
            address: item.to,
            sender: ENDPOINT_SENDER,
            text: `MoltZap: ${item.error}`,
          }),
        );
      default:
        return absurd(item);
    }
  }

  /**
   * Hand one projected message to NanoClaw's main session, replying to its
   * MoltZap address.
   * @param config The host callbacks from the active setup.
   * @param address The MoltZap conversation the message belongs to.
   * @param inbound The message in NanoClaw's inbox shape.
   * @returns Completion after the host callback completed.
   */
  private handToHost(
    config: ChannelSetup,
    address: string,
    inbound: InboundMessage,
  ): Effect.Effect<void, MoltZapChannelError> {
    const isGroup = inbound.isGroup === true;
    const content = JSON.stringify(inbound.content);
    if (content === undefined) {
      return Effect.fail(
        new MoltZapChannelError({
          reason: `NanoClaw could not serialize inbound content for ${address}`,
        }),
      );
    }
    return Effect.tryPromise({
      try: () => {
        config.onMetadata(address, address, isGroup);
        return Promise.resolve(
          config.onInboundEvent({
            channelType: NANOCLAW_MAIN_CHANNEL,
            instance: NANOCLAW_MAIN_CHANNEL,
            platformId: NANOCLAW_MAIN_PLATFORM_ID,
            threadId: null,
            message: {
              ...inbound,
              content,
            },
            replyTo: {
              channelType: MOLTZAP_CHANNEL,
              platformId: address,
              threadId: null,
            },
          }),
        );
      },
      catch: (cause) =>
        new MoltZapChannelError({
          reason: `NanoClaw inbound callback failed for ${address}: ${String(cause)}`,
        }),
    }).pipe(Effect.asVoid);
  }

  /**
   * Projects one explicit Client recipient into NanoClaw's native attention
   * signal and stable inbox shape.
   * @param message Addressed message delivered by Client.
   * @returns NanoClaw's stable native inbox representation.
   */
  private toInboundMessage(message: MoltZapInboundMessage): InboundMessage {
    const base = {
      id: message.postId,
      kind: "chat" as const,
      timestamp: MOLTZAP_INBOUND_TIMESTAMP,
      isMention: true,
    };
    switch (message.kind) {
      case "direct":
        return {
          ...base,
          content: {
            text: renderContent(message.content),
            address: message.address,
            sender: message.sender,
            senderId: message.sender,
          },
          isGroup: false,
        };
      case "group":
        return {
          ...base,
          content: {
            text: renderContent(message.content),
            address: message.address,
            sender: message.sender,
            senderId: message.sender,
            members: message.members,
          },
          isGroup: true,
        };
      default: {
        const exhaustiveMessage: never = message;
        return exhaustiveMessage;
      }
    }
  }
}

function makeMoltZapChannelAdapter(): MoltZapChannelAdapter | null {
  const { mcpEndpoint } = Effect.runSync(
    moltZapChannelEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
  return mcpEndpoint === null ? null : new MoltZapChannelAdapter(mcpEndpoint);
}

registerChannelAdapter(MOLTZAP_CHANNEL, {
  defaults: MOLTZAP_CHANNEL_DEFAULTS,
  factory: makeMoltZapChannelAdapter,
});

/* eslint-enable jsdoc/text-escaping -- Restore strict defaults after the Mermaid block. */
/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first defaults after the host boundary. */
