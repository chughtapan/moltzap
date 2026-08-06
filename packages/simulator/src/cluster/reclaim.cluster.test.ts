/** @file Live proof that a killed submitter still leaves its run reclaimed. */

// Reclamation cannot be shown against a fake: the fake worker never dies, so
// the assertion holds whether or not the worker outlives its submitter. This
// suite kills a real submitter against a real cluster and requires the run's
// namespace to disappear anyway.
//
// Opt in with the local-cluster-test target, against a cluster prepared by
// local-cluster-create and an image built by local-controller-image.

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-process-env-at-runtime, @typescript-eslint/no-invalid-void-type -- This suite drives a real cluster and a real child process through their native Promise and process APIs. */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { expect, it } from "vitest";
import { SYSTEM_NAMESPACE } from "./kubernetes/objects.js";

const RUN_NAMESPACE_PREFIX = "mz-";
const EXPERIMENT = resolve("local/end-to-end.mjs");
const SUBMITTER = resolve("dist/cluster/profiles/local.js");
const POLL_INTERVAL_MS = 2_000;
const SUBMISSION_ATTEMPTS = 150;
const RECLAMATION_ATTEMPTS = 150;

interface ClusterReader {
  readonly core: CoreV1Api;
  readonly custom: CustomObjectsApi;
}

function clusterReader(): ClusterReader {
  const config = new KubeConfig();
  config.loadFromDefault();
  return {
    core: config.makeApiClient(CoreV1Api),
    custom: config.makeApiClient(CustomObjectsApi),
  };
}

async function runNamespaces(reader: ClusterReader): Promise<string[]> {
  const namespaces = await reader.core.listNamespace({});
  return namespaces.items
    .map((namespace) => namespace.metadata?.name ?? "")
    .filter((name) => name.startsWith(RUN_NAMESPACE_PREFIX));
}

async function customObjectCount(
  reader: ClusterReader,
  group: string,
  version: string,
  plural: string,
): Promise<number> {
  const listed: unknown = await reader.custom.listCustomObjectForAllNamespaces({
    group,
    version,
    plural,
  });
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The generated custom-object client returns an untyped envelope; only its item list is read.
  const items: unknown = (listed as { readonly items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new Error(`${plural} did not list as a collection`);
  }
  return items.length;
}

async function until(
  attempts: number,
  description: string,
  satisfied: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await satisfied()) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${description} did not happen in time`);
}

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required by the local-cluster reclaim test`);
  }
  return value;
}

it("reclaims a run whose submitter is killed mid-flight", async () => {
  const reader = clusterReader();
  const controllerImage = requiredEnvironment("MOLTZAP_CONTROLLER_IMAGE");
  const before = new Set(await runNamespaces(reader));

  const submitter = spawn(process.execPath, [SUBMITTER, EXPERIMENT], {
    stdio: "ignore",
    env: { ...process.env, MOLTZAP_CONTROLLER_IMAGE: controllerImage },
  });

  let submitted = "";
  try {
    await until(
      SUBMISSION_ATTEMPTS,
      "the run namespace appearing",
      async () => {
        const created = (await runNamespaces(reader)).filter(
          (name) => !before.has(name),
        );
        submitted = created[0] ?? "";
        return submitted.length > 0;
      },
    );
  } finally {
    // SIGKILL, not SIGTERM: the guarantee under test is that a submitter which
    // never gets to run cleanup still leaves nothing behind.
    submitter.kill("SIGKILL");
  }

  await until(
    RECLAMATION_ATTEMPTS,
    `reclamation of ${submitted}`,
    async () => (await runNamespaces(reader)).length === 0,
  );

  expect(
    await customObjectCount(reader, "kueue.x-k8s.io", "v1beta2", "workloads"),
  ).toBe(0);
  expect(
    await customObjectCount(reader, "agents.x-k8s.io", "v1beta1", "sandboxes"),
  ).toBe(0);
  expect(await runNamespaces(reader)).toEqual([]);
  // The worker itself must survive the run it reclaimed, or the next submission
  // waits on a queue nothing is polling.
  expect(
    (await reader.core.readNamespace({ name: SYSTEM_NAMESPACE })).metadata
      ?.name,
  ).toBe(SYSTEM_NAMESPACE);
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-process-env-at-runtime, @typescript-eslint/no-invalid-void-type -- Restore Effect-first test rules after the live-cluster reclamation proof. */
