/**
 * The two catalogs a `moltzapd` listener can serve, and which one is current.
 *
 * A profile slot exists before Registry commit and has no service behind it, so
 * the daemon serves a slot catalog until an identity lands and the active
 * catalog afterward.
 */
import {
  agentConversationCreate,
  conversationList,
  conversationSearch,
} from "@moltzap/protocol/conversation";
import {
  AgentNotFoundError,
  agentsSearch,
  type AgentName,
} from "@moltzap/protocol/identity";
import { messagesRead, messagesSend } from "@moltzap/protocol/message";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import { Effect } from "effect";
import type { MoltZapChannelCore } from "./channel-core.js";
import type {
  HarnessSearchConversationsResult,
  HarnessStartConversationInput,
  HarnessStartConversationResult,
  HarnessStatusInput,
  HarnessStatusResult,
} from "./harness/index.js";
import type {
  HarnessActiveTools,
  HarnessDaemonPhase,
} from "./harness-mcp-wire.js";
import { drainPaginatedList } from "./pagination.js";
import type { MoltZapService } from "./service.js";

/** Answers the `status` tool in whichever catalog is current. */
export type StatusHandler = (
  payload: HarnessStatusInput,
) => Effect.Effect<HarnessStatusResult>;

/**
 * Tracks which catalog the listener serves. The MCP SDK builds a fresh server
 * per request, so flipping this is the whole state transition — the listener
 * is never rebound and its URL never changes.
 */
export interface DaemonPhaseState {
  readonly read: () => HarnessDaemonPhase;
  readonly setActive: (tools: HarnessActiveTools) => void;
}

/**
 * Creates the phase holder a daemon starts with.
 * @returns A phase reader plus its one-way transition to the active catalog.
 */
export const makeDaemonPhaseState = (): DaemonPhaseState => {
  let phase: HarnessDaemonPhase = { kind: "slot" };
  return {
    read: () => phase,
    setActive: (tools) => {
      phase = { kind: "active", tools };
    },
  };
};

/**
 * Answers `status` for a slot with no committed identity. There is no service
 * to ask, so it answers for itself: reachable, but holding nothing.
 * @returns The uncommitted slot's status.
 */
export const slotStatusHandler: StatusHandler = () =>
  Effect.succeed({ connected: false, conversations: 0 });

const makeStatusHandler =
  (service: MoltZapService, core: MoltZapChannelCore): StatusHandler =>
  () =>
    Effect.succeed({
      ...(service.ownAgentId === undefined
        ? {}
        : { agentId: service.ownAgentId }),
      connected: core.isConnected(),
      conversations: service.getConversations().length,
    });

const searchConversationsForHarness = (
  service: MoltZapService,
  params: ParamsOf<typeof conversationSearch>,
): Effect.Effect<HarnessSearchConversationsResult, unknown> =>
  Effect.gen(function* () {
    const page = yield* service.callDefinition(conversationSearch, params);
    const listed = yield* drainPaginatedList({
      definition: conversationList,
      sendRpc: (definition, listParams) =>
        service.callDefinition(definition, listParams),
      paramsForCursor: (cursor) => (cursor === undefined ? {} : { cursor }),
      rowsForPage: (listPage) => listPage.items,
      nextCursorForPage: (listPage) => listPage.nextCursor,
    });
    const participantsByConversation = new Map(
      listed.map((item) => [item.conversation.id, item.participants] as const),
    );
    return {
      conversations: page.conversations.map((conversation) => ({
        ...conversation,
        participants: [
          ...(participantsByConversation.get(conversation.id) ?? []),
        ],
      })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }).pipe(Effect.withSpan("moltzapd.searchConversations"));

const agentNotFound = (agentName: AgentName): AgentNotFoundError =>
  new AgentNotFoundError({
    message: `Agent not found: ${agentName}`,
    data: { agentName },
  });

const resolveAgentByName = (service: MoltZapService, name: AgentName) =>
  service.callDefinition(agentsSearch, { query: name }).pipe(
    Effect.flatMap(({ agents }) => {
      const agent = agents.find((candidate) => candidate.name === name);
      return agent === undefined
        ? Effect.fail(agentNotFound(name))
        : Effect.succeed(agent);
    }),
  );

const startConversationForHarness = (
  service: MoltZapService,
  input: HarnessStartConversationInput,
): Effect.Effect<HarnessStartConversationResult, unknown> =>
  Effect.gen(function* () {
    if (new Set(input.otherAgentNames).size !== input.otherAgentNames.length) {
      // eslint-disable-next-line agent-code-guard/effect-error-erasure -- Local MCP validation stays on the established broad Error boundary without adding a portable protocol error.
      return yield* Effect.fail(
        new Error("Conversation participants must be unique"),
      );
    }

    const participants = yield* Effect.forEach(
      input.otherAgentNames,
      (name) => resolveAgentByName(service, name),
      { concurrency: 2 },
    );
    const ownAgentId = service.ownAgentId;
    if (ownAgentId === undefined) {
      // eslint-disable-next-line agent-code-guard/effect-error-erasure -- A missing daemon identity is rejected at the local composition boundary whose existing contract is Error.
      return yield* Effect.fail(new Error("Daemon has no agent identity"));
    }
    if (participants.some((participant) => participant.id === ownAgentId)) {
      // eslint-disable-next-line agent-code-guard/effect-error-erasure -- Local MCP validation stays on the established broad Error boundary without adding a portable protocol error.
      return yield* Effect.fail(
        new Error("The daemon agent is an implicit conversation participant"),
      );
    }

    const created = yield* service.callDefinition(agentConversationCreate, {
      participants: participants.map((participant) => participant.id),
    });
    yield* service.callDefinition(messagesSend, {
      conversationId: created.conversation.id,
      parts: [{ type: "text", text: input.initialContent }],
    });

    // Participants are endpoint-owned context on the MCP boundary. The
    // canonical Conversation value sent over the network remains closed.
    return {
      conversation: {
        ...created.conversation,
        participants: [
          ownAgentId,
          ...participants.map((participant) => participant.id),
        ],
      },
    };
  }).pipe(Effect.withSpan("moltzapd.startConversation"));

/**
 * Binds the six active tools to one registered agent's service and core.
 * @param service Connected service for the slot's committed identity.
 * @param core Channel core owning the network connection.
 * @returns The active catalog's handlers.
 */
export const makeActiveTools = (
  service: MoltZapService,
  core: MoltZapChannelCore,
): HarnessActiveTools => ({
  readConversation: (payload) => service.callDefinition(messagesRead, payload),
  reply: core.sendReply.bind(core),
  searchAgents: (payload) => service.callDefinition(agentsSearch, payload),
  searchConversations: (payload) =>
    searchConversationsForHarness(service, payload),
  startConversation: (payload) => startConversationForHarness(service, payload),
  status: makeStatusHandler(service, core),
});
