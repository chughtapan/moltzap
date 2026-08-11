/** @file Private Layer assembled inside one run controller process. */
// safer-arch-ignore no-cross-domain-sibling-import: Assembles the controller's Layer from ledger, network, and cluster implementations.

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Duration, Layer } from "effect";
import { filesystemLedgerStorageLayer } from "../../ledger/filesystem.js";
import { serverProcessRouterProviderLayer } from "../../network/server/process.js";
import {
  makeInClusterKubernetesSocietyApi,
  type KubernetesSocietyApi,
} from "../kubernetes/calls.js";
import { kubernetesClusterLayer } from "../cohort.js";
import {
  controllerConfigurationFromEnvironment,
  type ControllerConfiguration,
  type ControllerEnvironment,
} from "./configuration.js";

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
  const host = Layer.merge(NodeContext.layer, NodeHttpClient.layerUndici);
  const run = Layer.mergeAll(
    filesystemLedgerStorageLayer(configuration.ledgerDirectory),
    serverProcessRouterProviderLayer({
      advertisedServerUrl: configuration.routerUrl,
      startupTimeout,
    }),
    kubernetesClusterLayer({
      api: societyApi,
      namespace: configuration.namespace,
      queueName: configuration.queueName,
      owner: configuration.owner,
      supportImage: configuration.supportImage,
      runtimeCredentials: configuration.runtimeCredentials,
      rosterPlacement: configuration.rosterPlacement,
      startupTimeout,
    }),
  );
  return run.pipe(Layer.provideMerge(host));
}

/**
 * Build the Layer at module-evaluation time for a mounted experiment RunSpec.
 *
 * This is deliberately a private deep import rather than a package export: the
 * experiment chooses its roster and Effect while the controller image owns all
 * Kubernetes and router mechanics.
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
