/** @file Private lifecycle composition for one registered endpoint daemon. */

import type { Implementation } from "@modelcontextprotocol/server";
import type { Registry } from "@moltzap/identity/registry";
import type { Router } from "@moltzap/router";
import { NodeFileSystem } from "@effect/platform-node";
import { WIRE_VERSION } from "@moltzap/identity";
import { Console, Effect, type Scope } from "effect";
import { beginFirewallAudit } from "../firewall/index.js";
import {
  type HistoryExportPort,
  makeHistoryExport,
  noHistoryExport,
} from "../harness/inbox/history-export.js";
import {
  acquireHarnessMcpHttpServer,
  type HarnessMcpEventHandler,
  LOOPBACK_HOST,
  makeHarnessMcpHttpHandler,
} from "../harness/mcp/index.js";
import { packageVersion } from "../release/index.js";
import { makeEndpointEngine } from "../transport/messaging/index.js";
import { makeRouterWorker } from "../transport/router/index.js";
import {
  type DaemonStartup,
  makeDaemon,
  type ProtocolEdges,
} from "./daemon/index.js";
import { DaemonRuntimeError, runtimeFailure } from "./errors.js";
import { makeDaemonManagementOperations } from "./management.js";

/** Closed daemon startup and supervision failure. */
export { DaemonRuntimeError };

/** Replaceable process edges used by focused lifecycle tests. */
export interface DaemonRuntimeDependencies extends ProtocolEdges {
  readonly makeHandler: typeof makeHarnessMcpHttpHandler;
  readonly acquireListener: (input: {
    readonly port: number;
    readonly handler: HarnessMcpEventHandler;
  }) => Effect.Effect<void, Error, Scope.Scope>;
  /** Opens the operator-configured history export against one file. */
  readonly makeHistoryExport: (
    path: string,
  ) => Effect.Effect<HistoryExportPort>;
}

const DAEMON_IMPLEMENTATION = {
  name: "sharnessd",
  version: packageVersion,
} satisfies Implementation;

const productionDependencies: DaemonRuntimeDependencies = {
  makeWorker: (input) => makeRouterWorker(input),
  makeEngine: makeEndpointEngine,
  makeHandler: makeHarnessMcpHttpHandler,
  acquireListener: ({ port, handler }) =>
    acquireHarnessMcpHttpServer({ port, handler }).pipe(Effect.asVoid),
  makeHistoryExport: (path) =>
    makeHistoryExport(path).pipe(Effect.provide(NodeFileSystem.layer)),
};

/**
 * Run all daemon-owned protocol and MCP resources until a supervised failure.
 * @param input The store, bootstrap and registration state read at startup.
 * @param dependencies Replaceable process edges used by focused lifecycle tests.
 * @returns A scoped process effect that ends only when a supervised resource fails.
 */
export const runDaemonRuntime = (
  input: DaemonStartup & { readonly auditExport?: string },
  dependencies: DaemonRuntimeDependencies = productionDependencies,
): Effect.Effect<never, DaemonRuntimeError, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const { auditExport, ...startup } = input;
    const audit =
      auditExport === undefined
        ? undefined
        : yield* beginFirewallAudit(auditExport, input.store).pipe(
            Effect.mapError(() => runtimeFailure("storage")),
          );
    return yield* Effect.scoped(runDaemonResources(startup, dependencies)).pipe(
      Effect.onExit(() =>
        audit === undefined ? Effect.void : audit.finish.pipe(Effect.orDie),
      ),
    );
  }).pipe(Effect.withSpan("runDaemonRuntime"));

/** Child resource finalizers finish before the outer audit reads the still-open store. */
function runDaemonResources(
  input: DaemonStartup,
  dependencies: DaemonRuntimeDependencies,
) {
  return Effect.gen(function* () {
    const historyExport = yield* openHistoryExport(input, dependencies);
    const daemon = yield* makeDaemon({
      ...input,
      historyExport,
      edges: dependencies,
    });
    const management = yield* makeDaemonManagementOperations({
      store: input.store,
      bootstrap: input.bootstrap,
      registration: daemon,
    });
    return yield* Effect.gen(function* () {
      yield* daemon.activateAtStart;
      const handler = yield* dependencies
        .makeHandler({
          implementation: DAEMON_IMPLEMENTATION,
          operations: Object.freeze({
            ...management,
            ...(input.firewall?.policy === undefined
              ? {}
              : { policy: input.firewall.policy }),
            ...daemon.deliveryOperations,
            protocolActive: daemon.protocolActive,
          }),
          credentials: input.bootstrap.mcpCredentials,
          eventStore: daemon.eventStore,
          onSubscriptionActiveChange: daemon.subscriptionChanged,
        })
        .pipe(Effect.mapError(() => runtimeFailure("storage")));
      yield* daemon.installHandler(handler);
      yield* daemon.runSubscriptions.pipe(Effect.forkScoped);
      yield* dependencies
        .acquireListener({
          port: input.bootstrap.configuration.mcpPort,
          handler,
        })
        .pipe(Effect.mapError(() => runtimeFailure("listener")));
      yield* Console.log(
        `sharnessd listening on http://${LOOPBACK_HOST}:${input.bootstrap.configuration.mcpPort}/mcp (package ${packageVersion}; WIRE_VERSION ${WIRE_VERSION})`,
      );
      return yield* daemon.awaitFailure;
    }).pipe(Effect.raceFirst(daemon.awaitFailure));
  });
}

/** An unset export path leaves certified history in endpoint-owned storage. */
function openHistoryExport(
  input: DaemonStartup,
  dependencies: DaemonRuntimeDependencies,
) {
  const path = input.bootstrap.configuration.historyExport;
  return path === undefined
    ? Effect.succeed(noHistoryExport)
    : dependencies.makeHistoryExport(path);
}
