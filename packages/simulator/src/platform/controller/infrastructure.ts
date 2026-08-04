/** @file Private Layer assembled inside one run controller process. */

import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { Duration, Layer } from "effect";
import { filesystemLedgerStorageLayer } from "../../ledger/filesystem.js";
import { RouterProvider } from "../../network/router.js";
import { makeServerProcessRouterProvider } from "../../network/server-process.js";
import {
  makeInClusterKubernetesSocietyApi,
  type KubernetesSocietyApi,
} from "../kubernetes/api.js";
import { kubernetesSocietyPlatformLayer } from "../kubernetes/platform.js";
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
 * Compose the complete private infrastructure for one in-cluster execution.
 * @param configuration Validated controller and run resource configuration.
 * @param api Narrow in-cluster operations, replaceable only by unit tests.
 * @returns One Layer suitable for the mounted experiment's RunSpec.
 */
function makeControllerInfrastructure(
  configuration: ControllerConfiguration,
  api?: KubernetesSocietyApi,
) {
  const societyApi =
    api ?? makeInClusterKubernetesSocietyApi(configuration.namespace);
  const startupTimeout = Duration.millis(configuration.startupTimeoutMs);
  const host = Layer.merge(NodeContext.layer, NodeHttpClient.layerUndici);
  const run = Layer.mergeAll(
    filesystemLedgerStorageLayer(configuration.ledgerDirectory),
    Layer.succeed(
      RouterProvider,
      makeServerProcessRouterProvider({
        advertisedServerUrl: configuration.routerUrl,
        startupTimeout,
      }),
    ),
    kubernetesSocietyPlatformLayer({
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
 * @returns One controller-owned infrastructure Layer.
 */
export function controllerInfrastructureFromEnvironment(
  environment?: ControllerEnvironment,
) {
  const resolvedEnvironment = environment ?? processControllerEnvironment();
  return makeControllerInfrastructure(
    controllerConfigurationFromEnvironment(resolvedEnvironment),
  );
}
