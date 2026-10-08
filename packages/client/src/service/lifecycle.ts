/** @file Private lifecycle composition for one registered endpoint daemon. */

import type { Implementation } from "@modelcontextprotocol/server";
import type { Registry } from "@moltzap/identity/registry";
import type { Router } from "@moltzap/router";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, type Scope } from "effect";
import {
  type HistoryExportPort,
  makeHistoryExport,
  noHistoryExport,
} from "../delivery/history-export.js";
import { packageVersion } from "../endpoint/implementation.js";
import {
  acquireHarnessMcpHttpServer,
  type HarnessMcpEventHandler,
  makeHarnessMcpHttpHandler,
} from "../endpoint/mcp/index.js";
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
  name: "moltzapd",
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
  input: DaemonStartup,
  dependencies: DaemonRuntimeDependencies = productionDependencies,
): Effect.Effect<never, DaemonRuntimeError, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const exportPath = input.bootstrap.configuration.historyExport;
    const historyExport =
      exportPath === undefined
        ? noHistoryExport
        : yield* dependencies.makeHistoryExport(exportPath);
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
      return yield* daemon.awaitFailure;
    }).pipe(Effect.raceFirst(daemon.awaitFailure));
  }).pipe(Effect.withSpan("runDaemonRuntime"));
