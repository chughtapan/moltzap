import type { Implementation } from "@modelcontextprotocol/server";
import { Effect, ExecutionStrategy, Exit, Scope } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { MoltZapChannelCore } from "./channel-core.js";
import type { HarnessTurnEvent } from "./harness/index.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";
import { makeHarnessMcpHttpHandlers } from "./harness-mcp-wire.js";
import type {
  localDaemonCommands,
  LocalDaemonHandlers,
} from "./local-daemon-rpc.js";
import { MoltZapService, type ServiceRpcError } from "./service.js";
import type { ServiceConfigError } from "./config.js";

interface MoltzapdOptions {
  readonly profileName: string;
  readonly port: number;
}

const MCP_IMPLEMENTATION = {
  name: "moltzapd",
  version: packageJson.version,
} satisfies Implementation;

type StatusHandler = LocalDaemonHandlers[typeof localDaemonCommands.status];
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
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- the process scope owns the sole core and its network connection
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
        reply: core.sendReply.bind(core),
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
