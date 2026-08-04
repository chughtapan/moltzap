import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Schema, Stream, type Scope } from "effect";
import type { conversationSearch } from "@moltzap/protocol/conversation";
import {
  agentsSearch,
  type AgentId,
  type AgentName,
} from "@moltzap/protocol/identity";
import { messagesRead } from "@moltzap/protocol/message";
import type {
  ParamsOf,
  ResultOf,
  RpcDefinitionAny,
} from "@moltzap/protocol/rpc";
import {
  projectHarnessTurn,
  type EnrichedInboundMessage,
} from "./channel-core.js";
import { reconstructHarnessContext } from "./harness-context-projection.js";
import {
  acquireHarnessClientInternal,
  HARNESS_READ_CONVERSATION_TOOL,
  HARNESS_SEARCH_AGENTS_TOOL,
  HARNESS_SEARCH_CONVERSATIONS_TOOL,
  HARNESS_START_CONVERSATION_TOOL,
  HARNESS_STATUS_TOOL,
  decodeHarnessSearchConversationsResult,
  decodeHarnessStartConversationResult,
  type ConversationWithParticipants,
  type HarnessClientInternalService,
  type HarnessTurnInternal,
} from "./harness/index.js";
import { statusCommandRpc } from "./local-daemon-rpc.js";

/** MCP-local conversation projection including participant identities. */
export type { ConversationWithParticipants } from "./harness/index.js";

/** Existing adapter presentation with reply authority bound to its live turn. */
export interface HarnessTurn extends EnrichedInboundMessage {
  /** Sends model output through the MCP reply route captured by this turn. */
  readonly reply: (payload: string) => Effect.Effect<void, Error>;
}

/** Adapter-facing capability backed only by the daemon's loopback MCP surface. */
export interface HarnessClientService {
  /** Active identity used by adapters when rendering self-authored context. */
  readonly agentId: AgentId;
  /** Creates a conversation with named peers and sends its initial content. */
  readonly startConversation: (
    otherAgentNames: readonly AgentName[],
    initialContent: string,
  ) => Effect.Effect<ConversationWithParticipants, Error>;
  /** The sole receive stream owned by this scoped client. */
  readonly turns: Stream.Stream<HarnessTurn, Error>;
}

/** Effect service tag consumed by runtime adapters. */
export class HarnessClient extends Context.Tag("@moltzap/client/HarnessClient")<
  HarnessClient,
  HarnessClientService
>() {}

/** Inputs needed to connect one scoped harness client. */
export interface HarnessClientOptions {
  /** Loopback `POST /mcp` endpoint owned by one running `moltzapd`. */
  readonly url: string;
}

const strictDecodeOptions = { onExcessProperty: "error" } as const;

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const callDescriptorTool = <D extends RpcDefinitionAny>(
  session: HarnessClientInternalService,
  toolName: string,
  definition: D,
  params: ParamsOf<D>,
): Effect.Effect<ResultOf<D>, Error> =>
  session
    .callTool(
      toolName,
      /* Safe because every RPC params Schema used here is a closed Struct and MCP tool arguments are JSON objects. */ params as Readonly<
        Record<string, unknown>
      >,
    )
    .pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknown(definition.resultSchema)(
          result,
          strictDecodeOptions,
        ).pipe(
          Effect.map(
            (decoded) =>
              /* Safe because ResultOf derives from this exact descriptor's resultSchema; RpcDefinitionAny erases only the runtime schema property's generic surface. */ decoded as ResultOf<D>,
          ),
        ),
      ),
      Effect.mapError(asError),
    );

const readActiveAgentId = (
  session: HarnessClientInternalService,
): Effect.Effect<AgentId, Error> =>
  session.callTool(HARNESS_STATUS_TOOL, {}).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknown(statusCommandRpc.successSchema)(
        result,
        strictDecodeOptions,
      ),
    ),
    Effect.mapError(asError),
    Effect.flatMap((status) => {
      if (status.agentId === undefined) {
        // eslint-disable-next-line agent-code-guard/effect-error-erasure -- A daemon with no active identity is rejected at the public client boundary, whose existing error contract is Error.
        return Effect.fail(
          new Error("Harness MCP status has no active AgentId"),
        );
      }
      return Effect.succeed(status.agentId);
    }),
  );

const startConversation = (
  session: HarnessClientInternalService,
  otherAgentNames: readonly AgentName[],
  initialContent: string,
): Effect.Effect<ConversationWithParticipants, Error> =>
  session
    .callTool(HARNESS_START_CONVERSATION_TOOL, {
      otherAgentNames,
      initialContent,
    })
    .pipe(
      Effect.flatMap(decodeHarnessStartConversationResult),
      Effect.map(({ conversation }) => conversation),
      Effect.mapError(asError),
    );

const searchConversations = (
  session: HarnessClientInternalService,
  params: ParamsOf<typeof conversationSearch>,
) =>
  session
    .callTool(HARNESS_SEARCH_CONVERSATIONS_TOOL, params)
    .pipe(
      Effect.flatMap(decodeHarnessSearchConversationsResult),
      Effect.mapError(asError),
    );

const contextReadPlane = (session: HarnessClientInternalService) => ({
  searchAgents: (params: ParamsOf<typeof agentsSearch>) =>
    callDescriptorTool(
      session,
      HARNESS_SEARCH_AGENTS_TOOL,
      agentsSearch,
      params,
    ),
  searchConversations: (params: ParamsOf<typeof conversationSearch>) =>
    searchConversations(session, params),
  readConversation: (params: ParamsOf<typeof messagesRead>) =>
    callDescriptorTool(
      session,
      HARNESS_READ_CONVERSATION_TOOL,
      messagesRead,
      params,
    ),
});

const projectTurn = (
  session: HarnessClientInternalService,
  checkpointStore: KeyValueStore.KeyValueStore,
  agentId: AgentId,
  turn: HarnessTurnInternal,
): Effect.Effect<HarnessTurn, Error> =>
  reconstructHarnessContext(contextReadPlane(session), turn.event).pipe(
    Effect.provideService(KeyValueStore.KeyValueStore, checkpointStore),
    Effect.map((context) => ({
      ...projectHarnessTurn({
        agents: context.agents,
        context: {
          conversations: context.conversations,
          crossConversationMessages: context.crossConversationMessages,
          currentMessages: context.currentMessages,
        },
        ownAgentId: agentId,
      }),
      reply: turn.reply,
    })),
    Effect.mapError(asError),
  );

/**
 * Acquires one turn-ready harness connection and receive stream for the
 * lifetime of the enclosing scope. The supplied KeyValueStore is local to the
 * active agent and holds only stable presentation checkpoints.
 *
 * @param options Fixed loopback MCP endpoint.
 * @returns The scoped adapter-facing service value.
 */
export const acquireHarnessClient = (
  options: HarnessClientOptions,
): Effect.Effect<
  HarnessClientService,
  Error,
  Scope.Scope | KeyValueStore.KeyValueStore
> =>
  Effect.gen(function* () {
    const checkpointStore = yield* KeyValueStore.KeyValueStore;
    const session = yield* acquireHarnessClientInternal(options);
    const agentId = yield* readActiveAgentId(session);
    return {
      agentId,
      startConversation: (
        otherAgentNames: readonly AgentName[],
        initialContent: string,
      ) => startConversation(session, otherAgentNames, initialContent),
      turns: session.turns.pipe(
        Stream.mapEffect((turn) =>
          projectTurn(session, checkpointStore, agentId, turn),
        ),
      ),
    };
  }).pipe(Effect.withSpan("acquireHarnessClient.presentation"));

/**
 * Builds the scoped runtime-adapter layer for one daemon endpoint.
 *
 * @param options Fixed loopback MCP endpoint.
 * @returns A Layer providing the scoped HarnessClient capability.
 */
export const makeHarnessClientLayer = (
  options: HarnessClientOptions,
): Layer.Layer<HarnessClient, Error, KeyValueStore.KeyValueStore> =>
  Layer.scoped(HarnessClient, acquireHarnessClient(options));
