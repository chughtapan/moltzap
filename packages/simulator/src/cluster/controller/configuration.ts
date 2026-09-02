/** @file Closed environment contract for the in-cluster run controller. */

import { Data, Either, Schema } from "effect";
import { isAbsolute } from "node:path";
import type { Image } from "../../agents/index.js";
import type { KubernetesPodPlacement } from "../profile.js";

// safer-arch-ignore no-cross-domain-sibling-import: Decodes one environment into the ledger and cluster values the controller needs.

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
// A queued cohort waits behind whole other runs, which take as long as their
// experiments do; an hour covers a handful of them without letting a cohort no
// queue will ever seat hold the controller for a day.
const DEFAULT_ADMISSION_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_COHORT_SIZE = 2;
// A thousand agents is the first size the decision defers to its acceptance
// gates, so the bound excludes it rather than admitting it.
const MAX_COHORT_SIZE = 1_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u;
const OWNER_UID = /^[A-Za-z0-9](?:[-A-Za-z0-9._]*[A-Za-z0-9])?$/u;
const DIGEST_PINNED_IMAGE = /^.+@sha256:[0-9a-f]{64}$/u;
const placementSchema = Schema.Struct({
  nodeSelector: Schema.Record({
    key: Schema.NonEmptyString,
    value: Schema.NonEmptyString,
  }),
  tolerations: Schema.Array(
    Schema.Struct({
      key: Schema.NonEmptyString,
      operator: Schema.Literal("Equal"),
      value: Schema.NonEmptyString,
      effect: Schema.Literal("NoSchedule"),
    }),
  ),
});
const decodePlacement = Schema.decodeEither(Schema.parseJson(placementSchema));
const runtimeCredentialsSchema = Schema.partial(
  Schema.Struct({
    ANTHROPIC_API_KEY: Schema.NonEmptyString,
    OPENAI_API_KEY: Schema.NonEmptyString,
  }),
);
const decodeRuntimeCredentials = Schema.decodeEither(
  Schema.parseJson(runtimeCredentialsSchema),
);

/** Environment source accepted by the private controller boundary. */
export type ControllerEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** Fully validated values shared by the entry point and cluster helper. */
export interface ControllerConfiguration {
  readonly namespace: string;
  readonly queueName: string;
  readonly owner: {
    readonly name: string;
    readonly uid: string;
  };
  readonly supportImage: Image;
  readonly applicationImage?: Image;
  readonly runtimeCredentials: Readonly<
    Partial<Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string>>
  >;
  readonly rosterPlacement?: KubernetesPodPlacement;
  readonly experimentModule: string;
  readonly ledgerDirectory: string;
  readonly ledgerExportDirectory?: string;
  readonly startupTimeoutMs: number;
  /** How long the queue may hold the cohort's reservation before the run gives up. */
  readonly admissionTimeoutMs: number;
  /** Agents an experiment sized by its run builds its roster from. */
  readonly cohortSize: number;
}

/** Safe configuration failure that never repeats a supplied environment value. */
export class ControllerConfigurationError extends Data.TaggedError(
  "ControllerConfigurationError",
)<{ readonly detail: string }> {
  override get message(): string {
    return `Controller configuration is invalid: ${this.detail}`;
  }
}

/**
 * Decode the one closed environment contract used by a controller Job.
 * @param environment Process environment or a deterministic test substitute.
 * @returns Safe, typed controller configuration.
 */
export function controllerConfigurationFromEnvironment(
  environment: ControllerEnvironment,
): ControllerConfiguration {
  return Object.freeze({
    namespace: kubernetesName(environment, "MOLTZAP_RUN_NAMESPACE"),
    queueName: kubernetesName(environment, "MOLTZAP_RUN_QUEUE"),
    owner: Object.freeze({
      name: kubernetesName(environment, "MOLTZAP_RUN_OWNER_NAME"),
      uid: ownerUid(environment),
    }),
    supportImage: supportImage(environment),
    applicationImage: optionalImage(environment, "MOLTZAP_APPLICATION_IMAGE"),
    runtimeCredentials: runtimeCredentials(environment),
    rosterPlacement: rosterPlacement(environment),
    experimentModule: experimentModulePath(environment),
    ledgerDirectory: absolutePath(environment, "MOLTZAP_LEDGER_DIRECTORY"),
    ledgerExportDirectory: optionalAbsolutePath(
      environment,
      "MOLTZAP_LEDGER_EXPORT_DIRECTORY",
    ),
    startupTimeoutMs: timeoutMs(
      environment,
      "MOLTZAP_STARTUP_TIMEOUT_MS",
      DEFAULT_STARTUP_TIMEOUT_MS,
    ),
    admissionTimeoutMs: timeoutMs(
      environment,
      "MOLTZAP_ADMISSION_TIMEOUT_MS",
      DEFAULT_ADMISSION_TIMEOUT_MS,
    ),
    cohortSize: cohortSize(environment),
  });
}

function kubernetesName(
  environment: ControllerEnvironment,
  key: string,
): string {
  const value = required(environment, key);
  if (value.length > 63 || !DNS_LABEL.test(value)) {
    throw invalid(`${key} must be one Kubernetes DNS label`);
  }
  return value;
}

function ownerUid(environment: ControllerEnvironment): string {
  const key = "MOLTZAP_RUN_OWNER_UID";
  const value = required(environment, key);
  if (value.length > 128 || !OWNER_UID.test(value)) {
    throw invalid(`${key} is not a Kubernetes object UID`);
  }
  return value;
}

function supportImage(environment: ControllerEnvironment): Image {
  return requiredImage(environment, "MOLTZAP_SUPPORT_IMAGE");
}

function optionalImage(
  environment: ControllerEnvironment,
  key: "MOLTZAP_APPLICATION_IMAGE",
): Image | undefined {
  const value = environment[key];
  return value === undefined ? undefined : decodeImage(value, key);
}

function requiredImage(
  environment: ControllerEnvironment,
  key: "MOLTZAP_SUPPORT_IMAGE",
): Image {
  return decodeImage(required(environment, key), key);
}

function decodeImage(value: string, key: string): Image {
  if (!DIGEST_PINNED_IMAGE.test(value)) {
    throw invalid(`${key} must be a lowercase SHA-256 digest-pinned image`);
  }
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The preceding closed pattern proves the template-literal image contract.
  return value as Image;
}

function optionalAbsolutePath(
  environment: ControllerEnvironment,
  key: string,
): string | undefined {
  return environment[key] === undefined
    ? undefined
    : absolutePath(environment, key);
}

function experimentModulePath(environment: ControllerEnvironment): string {
  const key = "MOLTZAP_EXPERIMENT_MODULE";
  const value = absolutePath(environment, key);
  if (!value.endsWith(".mjs")) {
    throw invalid(`${key} must be an absolute .mjs path`);
  }
  return value;
}

function timeoutMs(
  environment: ControllerEnvironment,
  key: "MOLTZAP_STARTUP_TIMEOUT_MS" | "MOLTZAP_ADMISSION_TIMEOUT_MS",
  fallback: number,
): number {
  const encoded = environment[key];
  if (encoded === undefined) {
    return fallback;
  }
  const value = Number(encoded);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw invalid(`${key} must be a positive integer no greater than 24 hours`);
  }
  return value;
}

function cohortSize(environment: ControllerEnvironment): number {
  const encoded = environment.MOLTZAP_COHORT_SIZE;
  if (encoded === undefined) {
    return DEFAULT_COHORT_SIZE;
  }
  const value = Number(encoded);
  if (!Number.isSafeInteger(value) || value <= 0 || value >= MAX_COHORT_SIZE) {
    throw invalid(
      `MOLTZAP_COHORT_SIZE must be a positive integer below ${String(MAX_COHORT_SIZE)}`,
    );
  }
  return value;
}

function rosterPlacement(
  environment: ControllerEnvironment,
): KubernetesPodPlacement | undefined {
  const encoded = environment.MOLTZAP_ROSTER_PLACEMENT;
  if (encoded === undefined) {
    return undefined;
  }
  const decoded = decodePlacement(encoded, { onExcessProperty: "error" });
  return Either.match(decoded, {
    onLeft: () => {
      throw invalid(
        "MOLTZAP_ROSTER_PLACEMENT must contain one closed placement object",
      );
    },
    onRight: (placement) => {
      if (
        Object.keys(placement.nodeSelector).length === 0 ||
        placement.tolerations.length === 0
      ) {
        throw invalid(
          "MOLTZAP_ROSTER_PLACEMENT must select and tolerate the roster pool",
        );
      }
      return Object.freeze({
        nodeSelector: Object.freeze({ ...placement.nodeSelector }),
        tolerations: Object.freeze(
          placement.tolerations.map((toleration) =>
            Object.freeze({ ...toleration }),
          ),
        ),
      });
    },
  });
}

function runtimeCredentials(
  environment: ControllerEnvironment,
): ControllerConfiguration["runtimeCredentials"] {
  const encoded = environment.MOLTZAP_RUNTIME_CREDENTIALS;
  if (encoded === undefined) {
    return Object.freeze({});
  }
  const decoded = decodeRuntimeCredentials(encoded, {
    onExcessProperty: "error",
  });
  return Either.match(decoded, {
    onLeft: () => {
      throw invalid(
        "MOLTZAP_RUNTIME_CREDENTIALS must contain only nonempty supported provider credentials",
      );
    },
    onRight: (credentials) => Object.freeze({ ...credentials }),
  });
}

function absolutePath(environment: ControllerEnvironment, key: string): string {
  const value = required(environment, key);
  if (!isAbsolute(value)) {
    throw invalid(`${key} must be an absolute path`);
  }
  return value;
}

function required(environment: ControllerEnvironment, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw invalid(`${key} is required`);
  }
  return value;
}

function invalid(detail: string): ControllerConfigurationError {
  return new ControllerConfigurationError({ detail });
}
