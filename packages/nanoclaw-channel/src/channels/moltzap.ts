/** @file Projects the public MoltZap endpoint capability into NanoClaw. */
import {
  acquireHarnessEndpoint,
  type ConnectError,
  type Content,
  type ContentPart,
  type DeliveryAcknowledgeError,
  type HarnessEndpoint,
  type InboundDelivery,
  type InboundMessage as MoltZapInboundMessage,
  type SendError,
  SendInput,
} from "@moltzap/client";
import {
  Config,
  ConfigProvider,
  Data,
  Deferred,
  Effect,
  Exit,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
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
const DEFAULT_AGENT_GROUP_ID = "agent";
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

interface MoltZapChannelEnv {
  readonly mcpEndpoint: string | null;
  readonly agentGroupId?: string;
}

interface MoltZapAdapterState {
  readonly agentGroupId: string;
  readonly injectedEndpoint: HarnessEndpoint | null;
  readonly mcpEndpoint: string | null;
}

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

/* eslint-disable @typescript-eslint/no-use-before-define -- The exported factory must precede internal story helpers; construction is deferred until after module initialization. */
/**
 * Create the production adapter when a loopback MCP URL is configured.
 * @param env Explicit environment, or process configuration when omitted.
 * @returns An MCP-backed adapter, or null when the channel is disabled.
 */
export function makeMoltZapAdapter(
  env?: MoltZapChannelEnv,
): MoltZapAdapter | null {
  const resolvedEnv: MoltZapChannelEnv =
    env ??
    Effect.runSync(
      moltZapChannelEnv.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    );
  return resolvedEnv.mcpEndpoint === null
    ? null
    : MoltZapAdapter.fromMcpEndpoint(
        resolvedEnv.mcpEndpoint,
        resolvedEnv.agentGroupId ?? DEFAULT_AGENT_GROUP_ID,
      );
}
/* eslint-enable @typescript-eslint/no-use-before-define -- Restore declaration-order checks after the deferred factory. */

function decodeOutboundSend(
  address: string,
  message: MoltZapOutboundMessage,
): Effect.Effect<SendInput, MoltZapChannelError> {
  return decodeOutboundText(message).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknown(SendInput)({
        to: address,
        content: [{ type: "text", text }],
      }),
    ),
    Effect.catchTag("ParseError", () =>
      Effect.fail(
        new MoltZapChannelError({
          reason:
            "MoltZap outbound delivery requires an explicit agent or group address and valid text",
        }),
      ),
    ),
  );
}

function decodeOutboundText(
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

function extractOutboundText(message: MoltZapOutboundMessage): string | null {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (
    content !== null &&
    typeof content === "object" &&
    "text" in content &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return null;
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

/**
 * NanoClaw adapter backed by exactly one scoped `HarnessEndpoint`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Client as HarnessEndpoint
 *   participant Adapter as MoltZapAdapter
 *   participant Host as NanoClaw host
 *   Client->>Adapter: InboundDelivery
 *   Adapter->>Host: onMetadata<br>address and group shape
 *   Adapter->>Host: await onInbound<br>stable PostId
 *   Adapter->>Client: acknowledge delivery
 *   Host->>Adapter: deliver<br>address and content
 *   Adapter->>Client: send addressed content
 * ```
 *
 * The stream acknowledges after the stock host callback completes.
 */
export class MoltZapAdapter {
  readonly name = MOLTZAP_CHANNEL;
  readonly channelType = MOLTZAP_CHANNEL;
  readonly supportsThreads = false;

  private readonly agentGroupId: string;
  private readonly injectedEndpoint: HarnessEndpoint | null;
  private readonly lifecycleGate = Effect.runSync(Effect.makeSemaphore(1));
  private readonly mcpEndpoint: string | null;
  private activation: MoltZapActivation | null = null;
  private setupConfig: ChannelSetup | null = null;

  private constructor(state: MoltZapAdapterState) {
    this.agentGroupId = state.agentGroupId;
    this.injectedEndpoint = state.injectedEndpoint;
    this.mcpEndpoint = state.mcpEndpoint;
  }

  /**
   * Build an adapter around an already-acquired public Client capability.
   * @param endpoint Scoped structural Client capability.
   * @returns An adapter that consumes the injected endpoint.
   */
  static fromEndpoint(
    endpoint: HarnessEndpoint,
    agentGroupId = DEFAULT_AGENT_GROUP_ID,
  ): MoltZapAdapter {
    return new MoltZapAdapter({
      agentGroupId,
      injectedEndpoint: endpoint,
      mcpEndpoint: null,
    });
  }

  /**
   * Build an adapter that acquires Client from one loopback MCP URL.
   * @param mcpEndpoint Loopback endpoint owned by the local daemon.
   * @returns An adapter that acquires the endpoint when set up.
   */
  static fromMcpEndpoint(
    mcpEndpoint: string,
    agentGroupId: string,
  ): MoltZapAdapter {
    return new MoltZapAdapter({
      agentGroupId,
      injectedEndpoint: null,
      mcpEndpoint,
    });
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
      function* (this: MoltZapAdapter) {
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
    if (this.injectedEndpoint !== null) {
      return Effect.succeed(this.injectedEndpoint);
    }
    const mcpEndpoint = this.mcpEndpoint;
    if (mcpEndpoint === null) {
      return Effect.fail(
        new MoltZapChannelError({
          reason: "MoltZap channel has no MCP endpoint",
        }),
      );
    }
    return Effect.try({
      try: () => new URL(mcpEndpoint),
      catch: () =>
        new MoltZapChannelError({
          reason: "MoltZap channel MCP endpoint is invalid",
        }),
    }).pipe(Effect.flatMap(acquireHarnessEndpoint), Scope.extend(scope));
  }

  private deliverEffect(
    address: string,
    message: MoltZapOutboundMessage,
  ): Effect.Effect<void, MoltZapChannelError | SendError> {
    const activation = this.activation;
    if (activation?.state !== "active") {
      return Effect.fail(
        new MoltZapChannelError({
          reason: "MoltZap channel is not connected",
        }),
      );
    }
    return decodeOutboundSend(address, message).pipe(
      Effect.flatMap((input) => activation.endpoint.send(input)),
    );
  }

  private handleDelivery(
    delivery: InboundDelivery,
  ): Effect.Effect<void, MoltZapChannelError | DeliveryAcknowledgeError> {
    const config = this.setupConfig;
    if (config === null) {
      return Effect.void;
    }
    const message = delivery.message;
    const address = message.address;
    const isGroup = message.kind === "group";
    const inbound = this.toInboundMessage(message);
    return Effect.tryPromise({
      try: () => {
        config.onMetadata(address, address, isGroup);
        return Promise.resolve(
          config.onInboundEvent({
            channelType: MOLTZAP_CHANNEL,
            instance: MOLTZAP_CHANNEL,
            platformId: address,
            targetAgentGroupId: this.agentGroupId,
            threadId: null,
            message: {
              ...inbound,
              content: JSON.stringify(inbound.content),
            },
          }),
        );
      },
      catch: (cause) =>
        new MoltZapChannelError({
          reason: `NanoClaw inbound callback failed for ${address}: ${String(cause)}`,
        }),
    }).pipe(Effect.zipRight(delivery.acknowledge), Effect.asVoid);
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

registerChannelAdapter(MOLTZAP_CHANNEL, {
  defaults: MOLTZAP_CHANNEL_DEFAULTS,
  factory: () => makeMoltZapAdapter(),
});

/* eslint-enable jsdoc/text-escaping -- Restore strict defaults after the Mermaid block. */
/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first defaults after the host boundary. */
