/** @file Generates package-local architecture analyzer configurations. */

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const publicTypePackage = {
  effect: {
    package: "effect",
    reason:
      "Foundational Effect runtime; intentionally part of the public contract",
  },
  platform: {
    package: "@effect/platform",
    reason: "Effect platform abstractions used at boundaries",
  },
  platformNode: {
    package: "@effect/platform-node",
    reason: "Effect Node integration used at boundaries",
  },
  rpc: {
    package: "@effect/rpc",
    reason:
      "RPC descriptors are the public contract; Rpc/RpcGroup types cross the boundary by design",
  },
  client: {
    package: "@moltzap/client",
    reason: "Intra-monorepo client SDK; channels depend on its public surface",
  },
  identity: {
    package: "@moltzap/identity",
    reason:
      "Identity-owned AgentName and VerifiedAgentCard are deliberately part of the semantic Client contract",
  },
  openclaw: {
    package: "openclaw",
    reason:
      "OpenClaw runtime options intentionally accept the runtime's native tools and sandbox policies",
  },
  simulator: {
    package: "@moltzap/simulator",
    reason:
      "The private evaluation application is built directly on the simulator's public contracts",
  },
};

const publicTypePackages = Object.entries(publicTypePackage)
  .filter(
    ([name]) =>
      name !== "identity" && name !== "openclaw" && name !== "simulator",
  )
  .map(([, definition]) => definition);

const allowedTestPublicSubpaths = [
  {
    subpath: "./test-utils",
    reason: "Test helpers exposed for cross-package integration testing",
  },
  {
    subpath: "./test",
    reason: "Test harness API for downstream packages",
  },
  {
    subpath: "./test-support",
    reason: "Channel test support exposed for integration tests",
  },
];

const sharedConfig = {
  publicTypePackages,
  allowedTestPublicSubpaths,
};

const packageDefinitions = {
  client: {
    afterShared: {
      publicTypePackages: [...publicTypePackages, publicTypePackage.identity],
    },
  },
  evals: {
    beforeShared: {
      maxPublicExports: 20,
      folderChildCountOverrides: [
        {
          folder: ".",
          maxChildren: 13,
          reason:
            "The evaluation application keeps its layered pipeline flat at the source root; each stage is one module named for the artifact it owns",
        },
      ],
      facadeFiles: [
        {
          file: "src/cases.ts",
          reason:
            "Code-defined case policies, exact peer rosters, and criteria form the private evaluation application's case boundary",
        },
        {
          file: "src/events.ts",
          reason:
            "Closed evaluation event catalog shared by case execution, transcript projection, and the simulator definition",
        },
        {
          file: "src/execution.ts",
          reason:
            "Mixed-roster execution and runtime-native condition adapters form the application execution boundary",
        },
        {
          file: "src/transcript.ts",
          reason:
            "Normalized transcript vocabulary and evidence-ID invariants every grading stage binds to",
        },
        {
          file: "src/judge.ts",
          reason:
            "Provider-neutral semantic judge contract shared by grading, calibration, and the OpenAI judge layer",
        },
        {
          file: "src/assessment.ts",
          reason:
            "Assessment provenance and criterion decisions shared by case grading and calibration binding",
        },
        {
          file: "src/phoenix.ts",
          reason:
            "Completed-report publication boundary the CLI composes; the Phoenix protocol modules stay behind it",
        },
        {
          file: "src/phoenix-publication.ts",
          reason:
            "Publication failure vocabulary and canonical JSON comparison every Phoenix protocol module binds to",
        },
        {
          file: "src/phoenix-experiment.ts",
          reason:
            "Per-condition experiment identity and reconciliation shared by dataset versioning and report publication",
        },
        {
          file: "src/sweep.ts",
          reason:
            "Durable report and sequential matrix execution boundary shared by the CLI and Phoenix publisher",
        },
      ],
    },
    afterShared: {
      publicTypePackages: [
        publicTypePackage.effect,
        publicTypePackage.platform,
        {
          ...publicTypePackage.client,
          reason:
            "The reduced Client surface supplies conversation identity and agent names to evaluation boundaries",
        },
        publicTypePackage.simulator,
      ],
      allowedTestPublicSubpaths: [],
    },
  },
  "nanoclaw-channel": {
    beforeShared: {
      sharedFolderNames: [
        {
          folder: "db",
          reason:
            "Host-substitution seam for the messaging-group module NanoClaw supplies when the adapter is installed.",
        },
      ],
    },
    afterShared: {
      publicTypePackages: [publicTypePackage.effect, publicTypePackage.client],
      allowedTestPublicSubpaths: [],
    },
  },
  "openclaw-channel": {
    beforeShared: {
      packageRuntime: "node",
    },
    afterShared: {
      publicTypePackages,
    },
  },
  simulator: {
    beforeShared: {
      packageRuntime: "node",
      minExportedSiblingModules: 5,
      maxPublicExports: 84,
      maxPublicReexports: 15,
      minPublicFacadeModules: 16,
      minFolderReadmeChildren: 100,
      folderChildCountOverrides: [
        {
          folder: "cluster",
          maxChildren: 16,
          reason:
            "Cluster is one subsystem whose children each name a step of a run's life: scaffold, cohort, reclaim, watch, install, bootstrap, and submit, plus its two vendor adapters and the controller that runs in-cluster",
        },
      ],
      facadeFiles: [
        {
          file: "ledger.ts",
          reason:
            "Published ledger contract for records, storage, live runs, and offline inspection",
        },
        {
          file: "agents.ts",
          reason:
            "Published runtime contract for autonomous agents, keyed rosters, and shipped runtime implementations",
        },
        {
          file: "events/catalog.ts",
          reason:
            "Nominal event-catalog boundary shared by definitions, ledger persistence, and event services",
        },
        {
          file: "events/core.ts",
          reason:
            "Closed kernel event catalog and producer-bound event writer contracts",
        },
        {
          file: "run/events.ts",
          reason:
            "Definition-bound Effect services for readable ledgers and customer-owned event emission",
        },
        {
          file: "ledger/schema.ts",
          reason:
            "Durable record, manifest, completion, digest, and ledger-reference model",
        },
        {
          file: "ledger/storage.ts",
          reason:
            "Storage port that keeps allocation, append, completion, and reading independent of the filesystem implementation",
        },
        {
          file: "ledger/append.ts",
          reason:
            "Live-ledger boundary for ordered append, failure latching, completion, and typed event streams",
        },
        {
          file: "ledger/read.ts",
          reason: "Completed-ledger validation and offline opening boundary",
        },
        {
          file: "run/outcomes.ts",
          reason:
            "Causal outcome conversion shared by runtime and program lifecycle modules",
        },
        {
          file: "run/execute.ts",
          reason:
            "Run boundary composing definitions, scoped resources, lifecycle outcomes, and the customer Effect",
        },
        {
          file: "cluster/cluster.ts",
          reason:
            "Cluster seam the run kernel acquires: the platform port plus the society and slot shapes every implementation satisfies",
        },
        {
          file: "cluster/submit.ts",
          reason:
            "Submission boundary shared by the local and GKE profiles, owning run identity and the sanitized failure they both report",
        },
        {
          file: "cluster/temporal.ts",
          reason:
            "The package's only Temporal adapter: worker, client, activity, and workflow bindings behind one Promise boundary",
        },
        {
          file: "cluster/kubernetes/calls.ts",
          reason:
            "The package's only Kubernetes API surface, wrapping a Promise-native client as typed Effects",
        },
        {
          file: "cluster/kubernetes/objects.ts",
          reason:
            "Every Kubernetes object the cluster creates, kept beside the calls that submit them",
        },
        {
          file: "cluster/controller/configuration.ts",
          reason:
            "Closed environment contract decoded once at the in-cluster controller boundary",
        },
        {
          file: "definition.ts",
          reason:
            "Public authoring surface composing catalogs, roster, cluster layer, and the customer Effect into one runnable spec",
        },
        {
          file: "agents/agent.ts",
          reason:
            "Autonomous participant lifecycle contract implemented by every runtime family",
        },
        {
          file: "agents/roster.ts",
          reason:
            "Keyed mixed-runtime roster preserving each agent's acquisition errors and Effect requirements",
        },
      ],
      layers: [
        {
          name: "controller",
          folders: ["cluster/controller"],
          reason:
            "The in-cluster executable that loads one spec and invokes the run kernel, so it depends on the kernel while nothing depends on it",
        },
        {
          name: "run",
          folders: ["run"],
          reason:
            "The run kernel orchestrates capability contracts without becoming a dependency of them",
        },
        {
          name: "capabilities",
          folders: [
            "events",
            "ledger",
            "agents",
            "cluster",
            "cluster/kubernetes",
            "cluster/profiles",
          ],
          reason:
            "Event, ledger, agent, and cluster capabilities compose through typed ports and do not form a truthful linear stack; each exposes a port the run kernel requires and hides its adapters behind it",
        },
      ],
    },
    afterShared: {
      publicTypePackages: [
        publicTypePackage.effect,
        publicTypePackage.platform,
        publicTypePackage.openclaw,
        publicTypePackage.identity,
      ],
      allowedTestPublicSubpaths: [],
    },
  },
};

const workspaceRoot = new URL("../../", import.meta.url);

const architectureConfigDefinitions = [
  ...Object.entries(packageDefinitions).map(([packageName, definition]) => ({
    packageRoot: `packages/${packageName}`,
    definition,
  })),
  {
    packageRoot: "packages/identity",
    definition: {
      config: {
        packageRuntime: "node",
        minExportedSiblingModules: 12,
        maxPublicExports: 40,
        minPublicFacadeModules: 13,
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
        ],
        allowedTestPublicSubpaths: [],
        folderReadmeFileNames: ["README.md", "MODULE.md"],
        folderChildCountOverrides: [
          {
            folder: ".",
            maxChildren: 12,
            reason:
              "The identity package keeps its closed identifier, key, signed-artifact, request-authentication, and Registry capability boundaries as peer deep modules",
          },
        ],
        facadeFiles: [
          {
            file: "agent-card.ts",
            reason:
              "Immutable Registry attestation boundary for issuance, verification, encoding, and digest operations",
          },
          {
            file: "http-signature.ts",
            reason:
              "Standards adapter boundary for the closed MoltZap HTTP signature profiles",
          },
          {
            file: "registry.ts",
            reason:
              "Public deep Registry capability and infrastructure-failure boundary",
          },
          {
            file: "registry/client.ts",
            reason:
              "Private HTTP adapter hidden behind the public Registry capability",
          },
          {
            file: "registry/contract.ts",
            reason:
              "Closed Registry request, result, operation value, representation, route, and client-failure contract",
          },
          {
            file: "registry/rpc.ts",
            reason:
              "Correlated in-process RPC boundary between HTTP admission and storage operations",
          },
          {
            file: "registry/server.ts",
            reason:
              "Production process-composition boundary exported through the Registry server subpath",
          },
          {
            file: "registry/storage.ts",
            reason:
              "Durable Registry storage capability and PostgreSQL implementation boundary",
          },
          {
            file: "registry/migrations/0001_registry.ts",
            reason:
              "Ordered PostgreSQL schema migration seam owned by Registry storage",
          },
        ],
      },
    },
  },
  {
    packageRoot: "packages/router",
    definition: {
      config: {
        packageRuntime: "node",
        publicTypePackages: [
          publicTypePackage.effect,
          publicTypePackage.platform,
        ],
        allowedTestPublicSubpaths: [],
        folderReadmeFileNames: ["README.md", "MODULE.md"],
        folderChildCountOverrides: [
          {
            folder: "router",
            maxChildren: 9,
            reason:
              "The Router implementation keeps contract, RPC, HTTP, send, poll, feed, cursor, waiters, and process as the cohesive boundaries of one independently runnable service",
          },
        ],
        facadeFiles: [
          {
            file: "router/feed.ts",
            reason:
              "Sole state boundary for ordering, retention, and retry identity",
          },
          {
            file: "router/contract.ts",
            reason:
              "Closed Router request, result, operation value, representation, route, limit, and client-failure contract",
          },
          {
            file: "router/poll.ts",
            reason:
              "Authenticated poll behavior boundary over cursor and feed capabilities",
          },
          {
            file: "router/poll-cursor.ts",
            reason:
              "Authenticated continuation boundary for caller-bound cursor state and process-scoped cursor material",
          },
          {
            file: "router/rpc.ts",
            reason:
              "Private correlated dispatch boundary between authenticated HTTP requests and send or poll operations",
          },
          {
            file: "router/send.ts",
            reason:
              "Authenticated send behavior boundary over identity proof and feed capabilities",
          },
        ],
      },
    },
  },
];

// Nothing in the analyzer complains about an allowance whose target does not
// exist, so a renamed or deleted path keeps passing while guarding nothing.
// These two helpers mirror how the analyzer resolves each key: a facade file is
// package-root relative and gains an implicit `src/` when it lacks one, while a
// folder key is relative to `src/`, with `.` naming `src/` itself.
const facadePath = (file) => {
  const trimmed = file.replace(/^\.\//, "");
  return trimmed.startsWith("src/") ? trimmed : `src/${trimmed}`;
};

const folderPath = (folder) => (folder === "." ? "src" : `src/${folder}`);

function pathClaims(config) {
  return [
    ...(config.facadeFiles ?? []).map((entry) => facadePath(entry.file)),
    ...(config.folderChildCountOverrides ?? []).map((entry) =>
      folderPath(entry.folder),
    ),
    ...(config.layers ?? []).flatMap((layer) => layer.folders.map(folderPath)),
  ];
}

const resolved = architectureConfigDefinitions.map(
  ({ packageRoot, definition }) => ({
    packageRoot,
    config: definition.config ?? {
      ...definition.beforeShared,
      ...sharedConfig,
      ...definition.afterShared,
    },
  }),
);

const danglingClaims = resolved.flatMap(({ packageRoot, config }) =>
  pathClaims(config)
    .map((claim) => `${packageRoot}/${claim}`)
    .filter((claim) => !existsSync(new URL(claim, workspaceRoot))),
);

if (danglingClaims.length > 0) {
  throw new Error(
    [
      "Architecture config names paths that do not exist:",
      ...danglingClaims.map((claim) => `  ${claim}`),
      "",
      "Every facadeFiles.file, folderChildCountOverrides.folder, and",
      "layers[].folders entry must name a real path. Fix the entry in",
      "scripts/architecture/gen-configs.mjs or restore the path it claims.",
    ].join("\n"),
  );
}

for (const { packageRoot, config } of resolved) {
  const configUrl = new URL(
    `${packageRoot}/safer-architecture.config.json`,
    workspaceRoot,
  );

  await writeFile(configUrl, `${JSON.stringify(config, null, 2)}\n`);
}
