/** @file Production composition for one explicitly configured endpoint daemon. */

import { NodeHttpClient } from "@effect/platform-node";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { Data, Duration, Effect, Layer } from "effect";
import {
  type InstalledFirewall,
  type FirewallOptions as InstalledFirewallOptions,
  installFirewall,
} from "../delivery/index.js";
import { inspectEndpointStore, openEndpointStore } from "../store/index.js";
import {
  DaemonConfigurationError,
  type DaemonProcessConfiguration,
} from "./bootstrap.js";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
  processHelp,
} from "./configuration.js";
import { runDaemonRuntime } from "./lifecycle.js";
import {
  readDaemonRegistrationState,
  requireAdmission,
  requireAdmissionToCreate,
} from "./registration/index.js";

// safer-arch-ignore no-large-public-surface: Trusted process composition and its operator audit decoder share this service-only boundary; moving the decoder to another entrypoint would split one fixed installation contract.

const REGISTRY_REQUEST_TIMEOUT = Duration.seconds(30);
const ROUTER_SEND_TIMEOUT = Duration.seconds(30);
const ROUTER_POLL_TIMEOUT = Duration.seconds(35);

/** Trusted operators decode retained checks without reading private storage schemas. */
export { FirewallAuditRecord } from "../delivery/index.js";

/** Checking factories have no daemon execution authority. */
export {
  CheckInputError,
  DecisionProviderError,
  makeEnglishPolicy,
  makeFirewall,
  makeJevDecisionProvider,
  MiddlewareError,
} from "../firewall/index.js";
/** Policy composition uses data contracts independently of agent-facing transport. */
export type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  EnglishPolicySettings,
  EnglishRule,
  Firewall,
  FirewallSettings,
  Message,
  MessageContext,
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareResult,
  RuleDescription,
} from "../firewall/index.js";

// eslint-disable-next-line @typescript-eslint/no-namespace -- The published service subpath intentionally merges its runtime values with the closed startup-error type.
export namespace Daemon {
  /** Usage text listing the daemon process's environment variables. */
  export const help = processHelp;

  /** Trusted fixed process composition; agents receive no policy mutation capability. */
  export type FirewallOptions = InstalledFirewallOptions & {
    /**
     * Dedicated file and adjacent `.partial` staging name for this endpoint's
     * state directory, privately owned by the daemon and published on shutdown.
     */
    readonly auditExport?: string;
  };

  /** Closed startup phase with sanitized configuration details. */
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly detail?: string;
  }> {
    /**
     * Only sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      return `moltzapd startup failed in phase ${this.phase}${detail}`;
    }
  }

  const runDaemon = (
    firewallSetup: Effect.Effect<InstalledFirewall | undefined, StartupError>,
    auditExport?: string,
  ) =>
    Effect.gen(function* () {
      const firewall = yield* firewallSetup;
      const configuration = yield* loadDaemonProcessConfiguration.pipe(
        Effect.mapError(configurationFailure),
      );
      const bootstrap = yield* loadDaemonBootstrap(configuration).pipe(
        Effect.mapError(configurationFailure),
      );
      const opening = yield* inspectEndpointStore(
        configuration.stateDirectory,
      ).pipe(Effect.mapError(storageFailure));
      yield* requireAdmissionToCreate(opening, bootstrap).pipe(
        Effect.mapError(configurationFailure),
      );
      const store = yield* openEndpointStore(configuration.stateDirectory).pipe(
        Effect.mapError(storageFailure),
      );
      const registration = yield* readDaemonRegistrationState({
        store,
        bootstrap,
      }).pipe(Effect.mapError(storageFailure));
      yield* requireAdmission(registration, bootstrap).pipe(
        Effect.mapError(configurationFailure),
      );
      const networkContext = yield* Layer.build(networkLayer(configuration));
      return yield* runDaemonRuntime({
        store,
        bootstrap,
        registration,
        ...(firewall === undefined ? {} : { firewall }),
        ...(auditExport === undefined ? {} : { auditExport }),
      }).pipe(
        Effect.provide(networkContext),
        // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The public process layer deliberately projects private runtime failures onto its closed startup phase.
        Effect.mapError((error) => new StartupError({ phase: error.phase })),
      );
    }).pipe(Effect.withSpan("Daemon.layer"));

  /** Complete production process composition for `moltzapd`. */
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(Effect.succeed(undefined)),
  );

  /**
   * Fixed middleware and owner evidence are installed before the daemon accepts host calls.
   * @param options Trusted process-owned chains and evidence, fixed for this daemon lifetime.
   * @returns The complete daemon layer with both message boundaries checked.
   */
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError> => {
    const { auditExport, ...policyOptions } = options;
    return Layer.scopedDiscard(
      runDaemon(
        installFirewall(policyOptions).pipe(
          Effect.mapError(configurationFailure),
        ),
        auditExport,
      ),
    );
  };

  function configurationFailure(cause: unknown): StartupError {
    return new StartupError({
      phase: "configuration",
      detail:
        cause instanceof DaemonConfigurationError ? cause.message : undefined,
    });
  }

  function storageFailure(): StartupError {
    return new StartupError({ phase: "storage" });
  }
}

function networkLayer(configuration: DaemonProcessConfiguration) {
  return Layer.merge(
    Registry.layer({
      origin: configuration.registryOrigin,
      registrySignerPublicKey: configuration.registrySignerPublicKey,
      requestTimeout: REGISTRY_REQUEST_TIMEOUT,
    }),
    Router.layer({
      origin: configuration.routerOrigin,
      sendTimeout: ROUTER_SEND_TIMEOUT,
      pollTimeout: ROUTER_POLL_TIMEOUT,
    }),
  ).pipe(Layer.provide(NodeHttpClient.layer));
}
