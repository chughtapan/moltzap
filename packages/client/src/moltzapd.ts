import type { Implementation } from "@modelcontextprotocol/server";
import { Effect, type Scope } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { MoltZapChannelCore } from "./channel-core.js";
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

const acquireConnectedCore = (
  service: MoltZapService,
): Effect.Effect<MoltZapChannelCore, ServiceRpcError, Scope.Scope> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- the process scope owns the sole core and its network connection
  Effect.acquireRelease(
    Effect.sync(() => new MoltZapChannelCore({ service })),
    (core) => core.disconnect(),
  ).pipe(Effect.tap((core) => core.connect()));

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
 *   process->>core: connect()
 *   process->>mcp: listen(port)
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
    const service = yield* MoltZapService.make(options.profileName);
    const core = yield* acquireConnectedCore(service);
    const handlers = makeHarnessMcpHttpHandlers({
      implementation: MCP_IMPLEMENTATION,
      status: makeStatusHandler(service, core),
    });
    return yield* acquireHarnessMcpHttpServer({
      port: options.port,
      registrationHandler: handlers.registration,
      harnessHandler: handlers.active,
    });
  }).pipe(Effect.withSpan("acquireMoltzapd"));
