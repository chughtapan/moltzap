// safer-arch-ignore no-cross-domain-sibling-import: Core app is the server composition root and must assemble identity registration with the protocol socket adapter.
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";

import { DbTag } from "#db";

import type { CoreApp } from "./types.js";
import type { CoreConfig } from "#config";
import { servicesLive, resolveServices } from "./layers.js";
import { makeNodeHttpServer, makeCoreHttpApp } from "#http";
import { makeMoltzapSocketHandler } from "../moltzap/server-socket.js";

function makeCoreRuntime(config: CoreConfig) {
  const baseLive = Layer.succeed(DbTag, config.db);
  const fullLive = Layer.provideMerge(servicesLive, baseLive);
  const dispatchRuntime = ManagedRuntime.make(
    Layer.mergeAll(NodeHttpServer.layerContext, fullLive),
  );
  const services = dispatchRuntime.runSync(resolveServices);
  return { dispatchRuntime, services };
}

/**
 * Creates core app.
 * @param config Documentation generation configuration.
 * @returns The created core app.
 */
export function createCoreApp(config: CoreConfig): CoreApp {
  const { dispatchRuntime, services } = makeCoreRuntime(config);
  const handleSocket = makeMoltzapSocketHandler({ services });
  const httpApp = makeCoreHttpApp({
    config,
    authService: services.authService,
    connections: services.connections,
    handleSocket,
  });
  const appScope = Effect.runSync(Scope.make());
  let actualPort = config.port;
  const startup = Effect.gen(function* () {
    const serverSvc = yield* NodeHttpServer.make(makeNodeHttpServer, {
      port: config.port,
      host: "0.0.0.0",
    });
    yield* serverSvc.serve(httpApp);
    const addr = serverSvc.address;
    actualPort = addr._tag === "TcpAddress" ? addr.port : config.port;
    yield* Effect.logInfo("MoltZap core server listening").pipe(
      Effect.annotateLogs({ port: actualPort }),
    );
  }).pipe(Effect.withSpan("createCoreApp.startup"), Scope.extend(appScope));

  dispatchRuntime.runPromise(startup).catch((err: unknown) => {
    Effect.runFork(
      Effect.logError("Server startup failed").pipe(
        Effect.annotateLogs({ err }),
      ),
    );
  });

  return makeCoreAppApi(() => actualPort);
}

function makeCoreAppApi(getPort: () => number): CoreApp {
  return {
    get port() {
      return getPort();
    },
  };
}
