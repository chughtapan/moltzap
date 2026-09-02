/** @file Private Layer assembled inside one run controller process. */

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Duration, Layer } from "effect";
import { filesystemLedgerStorageLayer } from "../../ledger/filesystem.js";
import { kubernetesClusterLayer } from "../cohort.js";
import {
  type KubernetesSocietyApi,
  makeInClusterKubernetesSocietyApi,
} from "../kubernetes/calls.js";
import { ROUTER_FAULT_PROXY_PORT } from "../kubernetes/objects.js";
import {
  type ControllerConfiguration,
  ControllerConfigurationError,
  controllerConfigurationFromEnvironment,
  type ControllerEnvironment,
} from "./configuration.js";

// safer-arch-ignore no-cross-domain-sibling-import: Assembles the controller's Layer from ledger and cluster implementations.

/**
 * Build the Layer at module-evaluation time for a mounted experiment RunSpec.
 *
 * This is deliberately a private deep import rather than a package export: the
 * experiment chooses its roster and Effect while the controller image owns all
 * Kubernetes and ledger mechanics.
 * @param environment Process environment or a deterministic test substitute.
 * @returns One controller-owned cluster Layer.
 */
export function controllerServicesFromEnvironment(
  environment?: ControllerEnvironment,
) {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  return makeControllerServices(
    controllerConfigurationFromEnvironment(resolvedEnvironment),
  );
}

/**
 * Read the cohort size the run was submitted with.
 *
 * An experiment whose roster is sized by its run reads it here rather than
 * from the process, so the value passes the same validation as every other
 * controller input instead of arriving unchecked.
 * @param environment Process environment or a deterministic test substitute.
 * @returns Agents the experiment should build its roster from.
 */
export function cohortSizeFromEnvironment(
  environment?: ControllerEnvironment,
): number {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  return controllerConfigurationFromEnvironment(resolvedEnvironment).cohortSize;
}

/**
 * Read the digest-pinned production-stack image selected for this run.
 * @param environment Process environment or a deterministic test substitute.
 * @returns The same validated support image used by Kubernetes composition.
 */
export function supportImageFromEnvironment(
  environment?: ControllerEnvironment,
) {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  return controllerConfigurationFromEnvironment(resolvedEnvironment)
    .supportImage;
}

/**
 * Read the complete agent image selected for an environment-driven experiment.
 * @param environment Process environment or a deterministic test substitute.
 * @returns The validated application image supplied with the run.
 */
export function applicationImageFromEnvironment(
  environment?: ControllerEnvironment,
) {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  const configuration =
    controllerConfigurationFromEnvironment(resolvedEnvironment);
  if (configuration.applicationImage === undefined) {
    throw new ControllerConfigurationError({
      detail: "MOLTZAP_APPLICATION_IMAGE is required by this experiment",
    });
  }
  return configuration.applicationImage;
}

function processControllerEnvironment(): ControllerEnvironment {
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- This private deep import is the experiment module's executable configuration boundary.
  return process.env;
}

/**
 * Compose the complete private cluster for one in-cluster execution.
 * @param configuration Validated controller and run resource configuration.
 * @param api Narrow in-cluster operations, replaceable only by unit tests.
 * @returns One Layer suitable for the mounted experiment's RunSpec.
 */
function makeControllerServices(
  configuration: ControllerConfiguration,
  api?: KubernetesSocietyApi,
) {
  const societyApi =
    api ?? makeInClusterKubernetesSocietyApi(configuration.namespace);
  const startupTimeout = Duration.millis(configuration.startupTimeoutMs);
  const admissionTimeout = Duration.millis(configuration.admissionTimeoutMs);
  const host = Layer.merge(NodeContext.layer, NodeHttpClient.layer);
  const run = Layer.mergeAll(
    filesystemLedgerStorageLayer(configuration.ledgerDirectory),
    kubernetesClusterLayer({
      api: societyApi,
      namespace: configuration.namespace,
      queueName: configuration.queueName,
      owner: configuration.owner,
      supportImage: configuration.supportImage,
      runtimeCredentials: configuration.runtimeCredentials,
      rosterPlacement: configuration.rosterPlacement,
      startupTimeout,
      admissionTimeout,
      routerFaultProxy: {
        listener: {
          bindHost: "0.0.0.0",
          port: ROUTER_FAULT_PROXY_PORT,
          advertisedOrigin: new URL(
            `http://controller.${configuration.namespace}.svc.cluster.local:${String(ROUTER_FAULT_PROXY_PORT)}`,
          ),
        },
      },
    }),
  );
  return run.pipe(Layer.provideMerge(host));
}
