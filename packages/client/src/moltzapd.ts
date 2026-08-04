import type { Implementation } from "@modelcontextprotocol/server";
import { Effect, ExecutionStrategy, Exit, Scope } from "effect";
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
import packageJson from "../package.json" with { type: "json" };
import { MoltZapChannelCore } from "./channel-core.js";
import type {
  HarnessSearchConversationsResult,
  HarnessStartConversationInput,
  HarnessStartConversationResult,
  HarnessStatusInput,
  HarnessStatusResult,
  HarnessTurnEvent,
} from "./harness/index.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";
import { makeHarnessMcpHttpHandlers } from "./harness-mcp-wire.js";
import { MoltZapService, type ServiceRpcError } from "./service.js";
import type { ServiceConfigError } from "./config.js";
import { drainPaginatedList } from "./pagination.js";

interface MoltzapdOptions {
  readonly profileName: string;
  readonly port: number;
}

const MCP_IMPLEMENTATION = {
  name: "moltzapd",
  version: packageJson.version,
} satisfies Implementation;

type StatusHandler = (
  payload: HarnessStatusInput,
) => Effect.Effect<HarnessStatusResult>;
type MoltzapdServer = Effect.Effect.Success<
  ReturnType<typeof acquireHarnessMcpHttpServer>
>;

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

const acquireCore = (
  service: MoltZapService,
): Effect.Effect<MoltZapChannelCore, ServiceRpcError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new MoltZapChannelCore({ service })),
    (core) => core.disconnect(),
  );

const installTurnPublisher = (
  core: MoltZapChannelCore,
  publish: (turn: HarnessTurnEvent) => boolean,
): void => {
  core.onRawInbound((messages) =>
    Effect.sync(() => {
      const first = messages[0];
      if (first === undefined) {
        return;
      }
      publish({ messages: [first, ...messages.slice(1)] });
    }),
  );
};

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
 * Owns one registered agent's service, channel core, network connection, and
 * guarded loopback MCP listener for the lifetime of the caller's scope.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant process as moltzapd
 *   participant service as MoltZapService
 *   participant core as MoltZapChannelCore
 *   participant mcp as MCP listener
 *
 *   process->>service: make(profileName)
 *   process->>core: construct(service)
 *   process->>core: install raw turn publisher
 *   process->>mcp: listen(port)
 *   process->>core: connect()
 *   Note over core,mcp: Scope release closes MCP before disconnecting the core
 * ```
 *
 * The caller resolves the profile and port policy. This composition does not
 * start the Unix-socket server and does not expose its service or core.
 *
 * @param options Existing profile name and caller-resolved listener port.
 * @returns The scoped loopback HTTP listener.
 * @internal
 */
export const acquireMoltzapd = (
  options: MoltzapdOptions,
): Effect.Effect<
  MoltzapdServer,
  Error | ServiceConfigError | ServiceRpcError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const daemonScope = yield* Scope.fork(
      parentScope,
      ExecutionStrategy.sequential,
    );
    const acquire = Effect.gen(function* () {
      const service = yield* MoltZapService.make(options.profileName);
      const core = yield* acquireCore(service);
      const handlers = makeHarnessMcpHttpHandlers({
        implementation: MCP_IMPLEMENTATION,
        readConversation: (payload) =>
          service.callDefinition(messagesRead, payload),
        reply: core.sendReply.bind(core),
        searchAgents: (payload) =>
          service.callDefinition(agentsSearch, payload),
        searchConversations: (payload) =>
          searchConversationsForHarness(service, payload),
        startConversation: (payload) =>
          startConversationForHarness(service, payload),
        status: makeStatusHandler(service, core),
      });
      installTurnPublisher(core, handlers.active.publish);
      const server = yield* acquireHarnessMcpHttpServer({
        port: options.port,
        registrationHandler: handlers.registration,
        harnessHandler: handlers.active,
      });
      yield* core.connect();
      return server;
    }).pipe(Scope.extend(daemonScope));
    return yield* acquire.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(daemonScope, exit),
      ),
    );
  }).pipe(Effect.withSpan("acquireMoltzapd"));

/**
 * Runs one agent daemon until the process runtime interrupts it.
 *
 * The process scope owns both the loopback MCP listener and the sole network
 * connection. Interrupting the returned Effect closes the listener before
 * disconnecting the agent transport.
 *
 * @param options Existing named profile and fixed loopback listener port.
 * @returns A non-terminating daemon Effect whose scope closes on interruption.
 */
export const runMoltzapd = (
  options: MoltzapdOptions,
): Effect.Effect<never, Error | ServiceConfigError | ServiceRpcError> =>
  Effect.scoped(
    acquireMoltzapd(options).pipe(Effect.zipRight(Effect.never)),
  ).pipe(Effect.withSpan("runMoltzapd"));
