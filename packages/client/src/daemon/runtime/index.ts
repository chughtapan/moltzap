/** @file Private lifecycle composition for one registered endpoint daemon. */

import type { Implementation } from "@modelcontextprotocol/server";
import type { Registry } from "@moltzap/identity/registry";
import type { Router } from "@moltzap/router";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, type Scope } from "effect";
import type { EndpointStore } from "../../endpoint/store.js";
import type { DaemonBootstrap } from "../configuration.js";
import packageJson from "../../../package.json" with { type: "json" };
import { noHistoryExport } from "../../endpoint/engine-types.js";
import { makeEndpointEngine } from "../../endpoint/engine.js";
import { makeRouterWorker } from "../../endpoint/router-worker/index.js";
import { acquireHarnessMcpHttpServer } from "../../harness-mcp-http.js";
import { makeHarnessMcpHttpHandler } from "../../harness-mcp-wire.js";
import {
  type DaemonRuntimeDependencies,
  DaemonRuntimeError,
  prepareDaemonActivation,
} from "./activation.js";
import { makeDaemonController } from "./controller.js";
import { makeHistoryExport } from "./history-export.js";

const DAEMON_IMPLEMENTATION = {
  name: "moltzapd",
  version: packageJson.version,
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

const runtimeFailure = (
  phase: DaemonRuntimeError["phase"],
): DaemonRuntimeError => new DaemonRuntimeError({ phase });

/** Closed daemon startup and supervision failure. */
export { DaemonRuntimeError };
/** Replaceable process edges used by focused lifecycle tests. */
export type { DaemonRuntimeDependencies };

/**
 * Run all daemon-owned protocol and MCP resources until a supervised failure.
 * @param input Daemon-owned persistence and fixed endpoint configuration.
 * @param input.store Durable endpoint store owned by this daemon process.
 * @param input.bootstrap Validated identity, network, and listener configuration.
 * @param dependencies Replaceable process edges used by focused lifecycle tests.
 * @returns A scoped process effect that ends only when a supervised resource fails.
 */
export const runDaemonRuntime = (
  input: {
    readonly store: EndpointStore;
    readonly bootstrap: DaemonBootstrap;
  },
  dependencies: DaemonRuntimeDependencies = productionDependencies,
): Effect.Effect<never, DaemonRuntimeError, Registry | Router | Scope.Scope> =>
  Effect.gen(function* () {
    const preparation = yield* prepareDaemonActivation(input);
    const exportPath = input.bootstrap.configuration.historyExport;
    const historyExport =
      exportPath === undefined
        ? noHistoryExport
        : yield* dependencies.makeHistoryExport(exportPath);
    const controller = yield* makeDaemonController({
      ...input,
      historyExport,
      management: preparation.management,
      dependencies,
    });
    yield* controller.initializeAtStart(preparation.registration);
    const handler = yield* dependencies
      .makeHandler({
        implementation: DAEMON_IMPLEMENTATION,
        operations: controller.operations,
        onSubscriptionActiveChange: controller.subscriptionChanged,
      })
      .pipe(Effect.mapError(() => runtimeFailure("storage")));
    yield* controller.installHandler(handler);
    yield* controller.runSubscriptions.pipe(Effect.forkScoped);
    yield* dependencies
      .acquireListener({
        port: input.bootstrap.configuration.mcpPort,
        handler,
      })
      .pipe(Effect.mapError(() => runtimeFailure("listener")));
    return yield* controller.awaitFailure;
  }).pipe(Effect.withSpan("runDaemonRuntime"));
