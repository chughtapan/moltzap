import type { Implementation } from "@modelcontextprotocol/server";
import { Effect, ExecutionStrategy, Exit, Scope } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { MoltZapChannelCore } from "./channel-core.js";
import type { HarnessTurnEvent } from "./harness/index.js";
import { acquireHarnessMcpHttpServer } from "./harness-mcp-server.js";
import { makeHarnessMcpHttpHandler } from "./harness-mcp-wire.js";
import {
  makeActiveTools,
  makeDaemonPhaseState,
  slotStatusHandler,
  type DaemonPhaseState,
} from "./moltzapd-catalog.js";
import { makeRegisterHandler } from "./moltzapd-registration.js";
import {
  isRegisteredProfile,
  parseProfileName,
  resolveProfileRecord,
} from "./profile.js";
import { MoltZapService, type ServiceRpcError } from "./service.js";
import type { ServiceConfigError } from "./config.js";

interface MoltzapdOptions {
  readonly profileName: string;
}

const MCP_IMPLEMENTATION = {
  name: "moltzapd",
  version: packageJson.version,
} satisfies Implementation;

type MoltzapdServer = Effect.Effect.Success<
  ReturnType<typeof acquireHarnessMcpHttpServer>
>;

/** Everything composing and running the daemon can fail with. */
type DaemonError = Error | ServiceConfigError | ServiceRpcError;

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

interface ActivatorInput {
  readonly profileName: string;
  readonly phase: DaemonPhaseState;
  readonly daemonScope: Scope.Scope;
}

// Builds the transition from a committed slot to a serving agent. Everything it
// acquires belongs to the daemon scope, so a slot that registers mid-life is
// torn down exactly like one that started registered.
const makeActivator =
  ({ profileName, phase, daemonScope }: ActivatorInput) =>
  (
    publish: (turn: HarnessTurnEvent) => boolean,
  ): Effect.Effect<void, ServiceConfigError | ServiceRpcError> =>
    Effect.gen(function* () {
      const service = yield* MoltZapService.make(profileName);
      const core = yield* acquireCore(service);
      installTurnPublisher(core, publish);
      yield* core.connect();
      phase.setActive(makeActiveTools(service, core));
    }).pipe(Scope.extend(daemonScope));

// Binds the slot's listener, then activates if the slot already carries an
// identity. The listener comes first either way: registration has to be
// reachable on a daemon that cannot yet build a service.
const serveProfileSlot = (
  profileName: string,
  daemonScope: Scope.Scope,
): Effect.Effect<MoltzapdServer, DaemonError, Scope.Scope> =>
  Effect.gen(function* () {
    const name = yield* parseProfileName(profileName);
    const record = yield* resolveProfileRecord(name);
    const phase = makeDaemonPhaseState();
    // Registration and its activation are one transition. Serializing them
    // keeps a second concurrent call from building a second service against
    // the same slot.
    const activation = yield* Effect.makeSemaphore(1);
    const activate = makeActivator({ profileName, phase, daemonScope });

    const handler = makeHarnessMcpHttpHandler({
      implementation: MCP_IMPLEMENTATION,
      phase: phase.read,
      slotStatus: slotStatusHandler,
      register: makeRegisterHandler({
        name,
        record,
        phase,
        activation,
        activate: () => activate(handler.publish),
        onCatalogChanged: () => {
          handler.notify.toolsChanged();
        },
      }),
    });

    const server = yield* acquireHarnessMcpHttpServer({
      port: record.mcpPort,
      handler,
    });
    if (isRegisteredProfile(record)) {
      yield* activate(handler.publish);
    }
    return server;
  });

/**
 * Owns one profile slot's loopback MCP listener for the lifetime of the
 * caller's scope, plus the service, channel core, and network connection once
 * that slot carries a Registry identity.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant process as moltzapd
 *   participant mcp as MCP listener
 *   participant service as MoltZapService
 *   participant core as MoltZapChannelCore
 *
 *   process->>mcp: listen(slot port) with the slot catalog
 *   alt slot has no identity
 *     mcp->>process: tools/call register
 *     process->>process: commit identity into the slot
 *   end
 *   process->>service: make(profileName)
 *   process->>core: construct(service)
 *   process->>core: install raw turn publisher
 *   process->>core: connect()
 *   process->>mcp: serve the active catalog
 *   Note over core,mcp: Scope release closes MCP before disconnecting the core
 * ```
 *
 * The slot itself carries the listener port, so no caller supplies one, and the
 * listener binds before the identity exists — an unregistered slot is reachable
 * at the same fixed `/mcp` URL as a registered one.
 *
 * @param options Existing profile name owning this daemon.
 * @returns The scoped loopback HTTP listener.
 * @internal
 */
export const acquireMoltzapd = (
  options: MoltzapdOptions,
): Effect.Effect<MoltzapdServer, DaemonError, Scope.Scope> =>
  Effect.gen(function* () {
    const parentScope = yield* Effect.scope;
    const daemonScope = yield* Scope.fork(
      parentScope,
      ExecutionStrategy.sequential,
    );
    const acquire = serveProfileSlot(options.profileName, daemonScope).pipe(
      Scope.extend(daemonScope),
    );
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
 * @param options Existing named profile owning this daemon.
 * @returns A non-terminating daemon Effect whose scope closes on interruption.
 */
export const runMoltzapd = (
  options: MoltzapdOptions,
): Effect.Effect<never, DaemonError> =>
  Effect.scoped(
    acquireMoltzapd(options).pipe(Effect.zipRight(Effect.never)),
  ).pipe(Effect.withSpan("runMoltzapd"));
