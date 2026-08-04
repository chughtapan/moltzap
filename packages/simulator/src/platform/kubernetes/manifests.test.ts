import { expect, it } from "vitest";
import {
  aggregateWorkloadManifest,
  bootstrapSecretManifest,
  sandboxManifest,
} from "./manifests.js";

const OWNER = { name: "run", uid: "run-uid" };
const SECRET_CONTENT = "secret-content";
const PARTIAL_ADMISSION_FIELD = "minCount";
const PLACEMENT = {
  nodeSelector: { "moltzap.dev/pool": "agents" },
  tolerations: [
    {
      key: "moltzap.dev/agents",
      operator: "Equal" as const,
      value: "true",
      effect: "NoSchedule" as const,
    },
  ],
};

function aggregateManifest(withPlacement = false) {
  return aggregateWorkloadManifest({
    namespace: "mz-run",
    name: "society",
    queueName: "simulator",
    labels: { "moltzap.dev/run": "run-1" },
    owner: OWNER,
    ...(withPlacement ? { placement: PLACEMENT } : {}),
    slots: [
      {
        image: "registry/openclaw@sha256:abc",
        requests: { cpu: "1", memory: "1Gi" },
      },
      {
        image: "registry/openclaw@sha256:def",
        requests: { memory: "1Gi", cpu: "1" },
      },
    ],
  });
}

function sandboxFixture(withPlacement = false) {
  return sandboxManifest({
    namespace: "mz-run",
    name: "agent-1-alice",
    labels: { "moltzap.dev/run": "run-1" },
    owner: OWNER,
    bootstrapSecretName: "agent-1-alice-bootstrap",
    supportImage: "registry/simulator@sha256:support",
    ...(withPlacement ? { placement: PLACEMENT } : {}),
    application: {
      image: "registry/openclaw@sha256:application",
      entrypoint: ["openclaw", "gateway", "run"],
      environment: { HOME: "/var/lib/moltzap/openclaw" },
      credentialEnvironment: ["OPENAI_API_KEY"],
      ports: [18_789],
      resources: {
        cpuMillis: 2_000,
        memoryBytes: 2_147_483_648,
        ephemeralStorageBytes: 2_147_483_648,
      },
    },
    credentialSecretKeys: {
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: "credential-OPENAI_API_KEY",
    },
  });
}

// eslint-disable-next-line agent-code-guard/no-example-only-tests -- these examples pin exact third-party manifest schemas and ordering omissions
it("reserves identical runtimes as one all-or-nothing pod set", () => {
  const manifest = aggregateManifest();
  expect(manifest).toMatchObject({
    apiVersion: "kueue.x-k8s.io/v1beta2",
    kind: "Workload",
    spec: {
      active: true,
      queueName: "simulator",
      podSets: [
        {
          count: 2,
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [
                {
                  name: "application",
                  resources: { requests: { cpu: "1", memory: "1Gi" } },
                },
              ],
            },
          },
        },
      ],
    },
  });
  expect(JSON.stringify(manifest)).not.toContain(PARTIAL_ADMISSION_FIELD);
});

it("rejects an empty roster before creating capacity", () => {
  let failure: unknown;
  try {
    aggregateWorkloadManifest({
      namespace: "mz-run",
      name: "society",
      queueName: "simulator",
      labels: {},
      owner: OWNER,
      slots: [],
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toMatchObject({
    detail: "aggregate capacity reservation requires at least one runtime",
  });
});

it("stores bootstrap content as immutable Secret data", () => {
  const manifest = bootstrapSecretManifest({
    namespace: "mz-run",
    name: "alice-bootstrap",
    labels: {},
    owner: OWNER,
    data: { "bootstrap.json": SECRET_CONTENT },
  });
  expect(manifest).toMatchObject({
    apiVersion: "v1",
    kind: "Secret",
    immutable: true,
    data: {
      "bootstrap.json": Buffer.from(SECRET_CONTENT).toString("base64"),
    },
  });
  expect(JSON.stringify(manifest)).not.toContain(SECRET_CONTENT);
});

it("creates one application container without bootstrap bytes in its environment", () => {
  const manifest = sandboxFixture();
  expect(manifest).toMatchObject({
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    spec: {
      service: true,
      podTemplate: {
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          initContainers: [
            { name: "bootstrap", image: "registry/simulator@sha256:support" },
          ],
          containers: [
            {
              name: "application",
              image: "registry/openclaw@sha256:application",
              command: ["openclaw"],
              args: ["gateway", "run"],
              env: [
                { name: "HOME", value: "/var/lib/moltzap/openclaw" },
                {
                  name: "OPENAI_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: "agent-1-alice-bootstrap",
                      key: "credential-OPENAI_API_KEY",
                      optional: false,
                    },
                  },
                },
              ],
              ports: [{ containerPort: 18_789, protocol: "TCP" }],
              resources: {
                requests: {
                  cpu: "2000m",
                  memory: "2147483648",
                  "ephemeral-storage": "2147483648",
                },
              },
            },
          ],
        },
      },
    },
  });
  expect(JSON.stringify(manifest)).not.toContain(SECRET_CONTENT);
});

it("projects identical GKE placement onto reserved and actual Pods", () => {
  const workload = aggregateManifest(true);
  const sandbox = sandboxFixture(true);

  expect(workload).toMatchObject({
    spec: { podSets: [{ template: { spec: PLACEMENT } }] },
  });
  expect(sandbox).toMatchObject({
    spec: { podTemplate: { spec: PLACEMENT } },
  });
});
