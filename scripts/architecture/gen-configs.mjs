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
};

const publicTypePackages = Object.values(publicTypePackage);

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
    beforeShared: {
      maxFolderCycles: 1,
      folderReadmeFileNames: ["README.md", "../README.md"],
      facadeFiles: [
        {
          file: "server.ts",
          reason:
            "Published process-composition boundary for the single configured endpoint daemon",
        },
        {
          file: "harness-mcp-wire.ts",
          reason:
            "Private MCP operation facade shared by the daemon runtime and management catalog",
        },
        {
          file: "harness-mcp-contract.ts",
          reason:
            "Private closed MCP schemas shared by daemon projection, loopback client decoding, and protocol-boundary tests",
        },
        {
          file: "management-runtime.ts",
          reason:
            "Exact private management schema boundary shared by daemon operations and its MCP catalog",
        },
        {
          file: "daemon/registration.ts",
          reason:
            "Crash-recoverable identity-registration boundary shared by daemon startup and management",
        },
        {
          file: "daemon/runtime/activation.ts",
          reason:
            "Identity activation, pinned-card recovery, and crash-recoverable registration shared by runtime composition, controller operations, and protocol acquisition",
        },
        {
          file: "endpoint/collective/operation.ts",
          reason:
            "Collective-layer facade: the daemon's stateful collective operations, which turn sends into posts and certified posts into inbound items",
        },
        {
          file: "endpoint/collective/wire.ts",
          reason:
            "Collective values carried in post content, shared by the operation layer and answer validation",
        },
        {
          file: "endpoint/engine.ts",
          reason:
            "Private endpoint-engine facade composing protocol phases behind the daemon-owned EndpointEngine capability",
        },
        {
          file: "endpoint/engine-durability.ts",
          reason:
            "Durable action-fold transition boundary shared by engine protocol phases",
        },
        {
          file: "endpoint/engine-send.ts",
          reason:
            "Addressed intent activation and durable send boundary shared by the endpoint engine phases",
        },
        {
          file: "endpoint/engine-types.ts",
          reason:
            "Closed endpoint-engine port and error vocabulary shared by every protocol phase",
        },
        {
          file: "endpoint/router-worker/types.ts",
          reason:
            "Closed Router-worker state, error, and retry vocabulary shared by the worker and its outage handling",
        },
        {
          file: "endpoint/representation-codec.ts",
          reason:
            "Canonical encoding, signing, and hashing boundary beneath the complete representation facade",
        },
        {
          file: "endpoint/representation.ts",
          reason:
            "Complete private protocol-representation facade consumed by endpoint and daemon modules",
        },
        {
          file: "endpoint/recovery/state.ts",
          reason:
            "Volatile catch-up and re-anchor coordination shared only by the recovery facade and its re-anchor implementation",
        },
        {
          file: "endpoint/store.ts",
          reason:
            "Private typed facade for the daemon-owned endpoint replica and its recovery state",
        },
        {
          file: "endpoint/store/deliveries.ts",
          reason:
            "Pending-delivery SQL capability shared by record promotion, management recovery reads, and endpoint-store operations",
        },
        {
          file: "endpoint/store/dissemination.ts",
          reason:
            "Dissemination-obligation SQL capability shared by record promotion, recovery reads, and atomic outbox enqueue",
        },
        {
          file: "endpoint/store/outbound.ts",
          reason:
            "Durable outbox SQL capability shared by endpoint-store operations, recovery reads, and dissemination transactions",
        },
      ],
      layers: [
        {
          name: "runtime-transport",
          folders: ["client-runtime", "harness-mcp-events"],
          reason:
            "MCP transport projects endpoint values and durable event state; endpoint semantics never depend on HTTP delivery",
        },
        {
          name: "daemon",
          folders: ["daemon"],
          reason:
            "Process composition may depend on endpoint capabilities while endpoint protocol code never depends on daemon lifecycle",
        },
        {
          name: "endpoint",
          folders: ["endpoint"],
          reason:
            "Endpoint protocol, durability, recovery, Router work, and addressed delivery form the daemon's private semantic core",
        },
      ],
    },
    afterShared: {
      publicTypePackages,
    },
  },
  "nanoclaw-channel": {
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
