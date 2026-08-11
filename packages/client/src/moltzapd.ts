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
  readonly activationScope: Scope.Scope;
}

interface DaemonResourceScopes {
  readonly activationScope: Scope.CloseableScope;
  readonly daemonScope: Scope.CloseableScope;
}

/**
 * Creates the daemon's nested resource owners. The activation scope is
 * registered before the listener, so sequential LIFO shutdown closes the MCP
 * listener before disconnecting the active channel core.
 * @param parentScope Scope that owns the complete daemon lifetime.
 * @returns Separate owners for the listener and activation resources.
 * @internal
 */
export const makeDaemonResourceScopes = (
  parentScope: Scope.Scope,
): Effect.Effect<DaemonResourceScopes> =>
  Effect.gen(function* () {
    const daemonScope = yield* Scope.fork(
      parentScope,
      ExecutionStrategy.sequential,
    );
    const activationScope = yield* Scope.fork(
      daemonScope,
      ExecutionStrategy.sequential,
    );
    return { activationScope, daemonScope };
  }).pipe(Effect.withSpan("makeDaemonResourceScopes"));

/**
 * Runs one activation attempt in a child of the daemon scope.
 *
 * A successful attempt remains owned by the daemon. A failed or interrupted
 * attempt closes completely before its error reaches the caller, so a later
 * attempt cannot overlap a partial service, core, or network connection.
 *
 * @param daemonScope Scope owning a successful activation.
 * @param attempt Scoped resources acquired by one activation attempt.
 * @returns The attempt result after failed resources have been released.
 * @internal
 */
export const runScopedActivationAttempt = <A, E>(
  daemonScope: Scope.Scope,
  attempt: Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const attemptScope = yield* Scope.fork(
        daemonScope,
        ExecutionStrategy.sequential,
      );
      return yield* restore(attempt.pipe(Scope.extend(attemptScope))).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(attemptScope, exit),
        ),
      );
    }),
  ).pipe(Effect.withSpan("runScopedActivationAttempt"));

// Builds the transition from a committed slot to a serving agent. Each attempt
// has its own child scope so a failed startup cannot leak partial resources
// into the daemon lifetime.
const makeActivator =
  ({ profileName, phase, activationScope }: ActivatorInput) =>
  (
    publish: (turn: HarnessTurnEvent) => boolean,
  ): Effect.Effect<void, ServiceConfigError | ServiceRpcError> =>
    runScopedActivationAttempt(
      activationScope,
      Effect.gen(function* () {
        const service = yield* MoltZapService.make(profileName);
        const core = yield* acquireCore(service);
        installTurnPublisher(core, publish);
        yield* core.connect();
        phase.setActive(makeActiveTools(service, core));
      }),
    );

// Binds the slot's listener, then activates if the slot already carries an
// identity. The listener comes first either way: registration has to be
// reachable on a daemon that cannot yet build a service.
const serveProfileSlot = (
  profileName: string,
  activationScope: Scope.Scope,
): Effect.Effect<MoltzapdServer, DaemonError, Scope.Scope> =>
  Effect.gen(function* () {
    const name = yield* parseProfileName(profileName);
    const record = yield* resolveProfileRecord(name);
    const phase = makeDaemonPhaseState();
    // Registration and initial activation share one transition lock so a live
    // listener cannot begin another registration during startup.
    const activation = yield* Effect.makeSemaphore(1);
    const activate = makeActivator({ profileName, phase, activationScope });

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
      yield* activation.withPermits(1)(activate(handler.publish));
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
    const { activationScope, daemonScope } =
      yield* makeDaemonResourceScopes(parentScope);
    const acquire = serveProfileSlot(options.profileName, activationScope).pipe(
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
 * @param readySignal Effect that tells a supervising process this daemon owns
 * its listener and, for a registered profile, its network connection.
 * @returns A non-terminating daemon Effect whose scope closes on interruption.
 */
export const runMoltzapd = (
  options: MoltzapdOptions,
  readySignal: Effect.Effect<unknown, Error>,
): Effect.Effect<never, DaemonError> =>
  Effect.scoped(
    acquireMoltzapd(options).pipe(
      Effect.zipRight(readySignal),
      Effect.zipRight(Effect.never),
    ),
  ).pipe(Effect.withSpan("runMoltzapd"));
