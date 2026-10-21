/** @file Production composition for one explicitly configured endpoint daemon. */

import { NodeSdk } from "@effect/opentelemetry";
import { NodeHttpClient } from "@effect/platform-node";
import { wireVersions } from "@moltzap/identity";
import { Registry } from "@moltzap/identity/registry";
import { Router } from "@moltzap/router";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config, Data, Duration, Effect, Layer, Option } from "effect";
import {
  type FirewallOptions as InstalledFirewallOptions,
  installEditableFirewall,
} from "../delivery/index.js";
import { packageVersion } from "../endpoint/implementation.js";
import {
  type EndpointStoreError,
  inspectEndpointStore,
  openEndpointStore,
  type OutboxTooOldError,
} from "../store/index.js";
import {
  DaemonConfigurationError,
  type DaemonProcessConfiguration,
} from "./bootstrap.js";
import {
  loadDaemonBootstrap,
  loadDaemonProcessConfiguration,
  processHelp,
} from "./configuration.js";
import { type DaemonRuntimeError, runDaemonRuntime } from "./lifecycle.js";
import {
  type DaemonRegistrationPersistenceError,
  type DaemonRegistrationRepresentationError,
  readDaemonRegistrationState,
  requireAdmission,
  requireAdmissionToCreate,
} from "./registration/index.js";

// safer-arch-ignore no-large-public-surface: Trusted process composition and its operator audit decoder share this service-only boundary; moving the decoder to another entrypoint would split one fixed installation contract.

const REGISTRY_REQUEST_TIMEOUT = Duration.seconds(30);
const ROUTER_SEND_TIMEOUT = Duration.seconds(30);
const ROUTER_POLL_TIMEOUT = Duration.seconds(35);

const liveWireVersions = wireVersions.liveSet;

const spanExportSettings = Config.all({
  endpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")),
  protocol: Config.string("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL").pipe(
    Config.orElse(() => Config.string("OTEL_EXPORTER_OTLP_PROTOCOL")),
    Config.withDefault("http/protobuf"),
  ),
  serviceName: Config.string("OTEL_SERVICE_NAME").pipe(
    Config.withDefault("sharnessd"),
  ),
});

/**
 * Exports every span the daemon records as OTLP/HTTP protobuf while
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set; unset, the layer is empty and no
 * exporter exists. A trace protocol other than http/protobuf, from
 * `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` or `OTEL_EXPORTER_OTLP_PROTOCOL`, is
 * refused at startup rather than exported in a format the collector does not
 * expect. The OpenTelemetry exporter and batch processor read the rest of
 * their standard variables themselves, and the resource takes
 * `OTEL_RESOURCE_ATTRIBUTES`.
 */
const spanExport: Layer.Layer<never, DaemonConfigurationError> =
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const settings = yield* spanExportSettings.pipe(Effect.orDie);
      if (Option.isNone(settings.endpoint)) {
        return Layer.empty;
      }
      if (settings.protocol !== "http/protobuf") {
        return yield* new DaemonConfigurationError({
          reason: "environment",
          message:
            "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL and OTEL_EXPORTER_OTLP_PROTOCOL support only http/protobuf",
        });
      }
      return NodeSdk.layer(() => ({
        resource: {
          serviceName: settings.serviceName,
          serviceVersion: packageVersion,
        },
        spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
      })).pipe(Layer.discard);
    }),
  );

/** Trusted operators decode retained checks without reading private storage schemas. */
export { FirewallAuditRecord } from "../delivery/index.js";

/** Checking factories have no daemon execution authority. */
export {
  CheckInputError,
  DecisionProviderError,
  FirewallPolicyError,
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

  /** Trusted process composition fixes code and evidence while owner tools edit English rules. */
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
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "legacy-key";
    readonly keys?: readonly string[];
    readonly detail?: string;
  }> {
    /**
     * Only closed refusal reasons and sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const reason = this.reason === undefined ? "" : ` (${this.reason})`;
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      let remedy = "";
      if (this.reason === "pre-reset") {
        remedy =
          ". Start with a fresh state directory and register again; see https://github.com/chughtapan/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      } else if (this.reason === "outbox-too-old") {
        remedy =
          ". Drain the outbox on the previous release before upgrading, or apply a reset release; see https://github.com/chughtapan/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      }
      return `sharnessd startup failed in phase ${this.phase}${reason}${detail}${remedy}`;
    }
  }

  const runDaemon = (
    firewallOptions?: InstalledFirewallOptions,
    auditExport?: string,
  ) =>
    Effect.gen(function* () {
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
      const store = yield* openEndpointStore(configuration.stateDirectory, {
        liveWireVersions: yield* liveWireVersions,
      }).pipe(Effect.mapError(storageFailure));
      const firewall =
        firewallOptions === undefined
          ? undefined
          : yield* installEditableFirewall(firewallOptions, store).pipe(
              Effect.mapError(configurationFailure),
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
        Effect.mapError(runtimeStartupFailure),
      );
    }).pipe(Effect.withSpan("Daemon.layer"));

  /**
   * The opt-in span export each composition is built inside, so it closes
   * after the daemon and flushes every span the daemon ended.
   */
  const telemetry = Layer.mapError(spanExport, configurationFailure);

  /** Complete production process composition for `sharnessd`. */
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  ).pipe(Layer.provide(telemetry));

  /**
   * Fixed middleware and persisted English rules are installed before the daemon accepts host calls.
   * @param options Fixed chains, provider settings and initial editable English documents.
   * @returns The complete daemon layer with both message boundaries checked.
   */
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError> => {
    const { auditExport, ...policyOptions } = options;
    return Layer.scopedDiscard(runDaemon(policyOptions, auditExport)).pipe(
      Layer.provide(telemetry),
    );
  };

  /**
   * Public startup failures retain the phase and actionable compatibility refusal.
   * @param error Private runtime failure to project onto the process boundary.
   * @returns The closed startup error without private runtime detail.
   */
  function runtimeStartupFailure(error: DaemonRuntimeError): StartupError {
    return new StartupError({
      phase: error.phase,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    });
  }

  function configurationFailure(cause: unknown): StartupError {
    return new StartupError({
      phase: "configuration",
      ...(cause instanceof DaemonConfigurationError &&
      cause.reason === "legacy-key"
        ? { reason: "legacy-key" as const, keys: cause.keys }
        : {}),
      detail:
        cause instanceof DaemonConfigurationError ? cause.message : undefined,
    });
  }

  /** Operational failures keep their storage phase; only reset boundaries add a reason. */
  const storeStartupReasons = {
    "pre-reset": "pre-reset",
    "newer-schema": "newer-schema",
    closed: undefined,
    conflict: undefined,
    corrupt: undefined,
    incompatible: undefined,
    "invalid-continuation": undefined,
    "invalid-input": undefined,
    "not-found": undefined,
    persistence: undefined,
  } satisfies Record<EndpointStoreError["reason"], StartupError["reason"]>;

  function storageFailure(
    error:
      | EndpointStoreError
      | OutboxTooOldError
      | DaemonRegistrationPersistenceError
      | DaemonRegistrationRepresentationError,
  ): StartupError {
    switch (error._tag) {
      case "DaemonRegistrationPersistenceError":
      case "DaemonRegistrationRepresentationError":
        return new StartupError({ phase: "storage" });
      case "OutboxTooOldError":
        return new StartupError({ phase: "storage", reason: "outbox-too-old" });
      case "EndpointStoreError":
        return new StartupError({
          phase: "storage",
          reason: storeStartupReasons[error.reason],
        });
      default: {
        const exhaustive: never = error;
        return exhaustive;
      }
    }
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
