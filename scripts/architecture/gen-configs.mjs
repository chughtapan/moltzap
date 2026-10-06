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

/**
 * The client's domains, lowest layer first. A domain may import only the
 * entrypoints of domains listed before it; the generator derives both the
 * CUPID domains and the layer order from this one list.
 */
const clientDomains = [
  {
    name: "identity",
    root: "identity",
    entrypoints: ["index.ts"],
    reason:
      "The agent signing key and secret credential files, read exactly and failing closed",
  },
  {
    name: "wire",
    root: "transport/wire",
    entrypoints: [
      "index.ts",
      {
        file: "values.ts",
        reason:
          "Addresses, post ids, content, and member limits hosts decode without loading signing, verification, or the Router client",
      },
    ],
    reason:
      "Canonical protocol encoding, verification, and the message values every layer encodes",
  },
  {
    name: "store",
    root: "store",
    entrypoints: [
      "index.ts",
      {
        file: "types.ts",
        reason:
          "Store value schemas hosts read without loading the SQLite store",
      },
    ],
    reason:
      "The one SQLite replica: certified history, outbox, deliveries, and the host inbox and send records as opaque bytes",
  },
  {
    name: "router",
    root: "transport/router",
    entrypoints: ["index.ts"],
    reason: "The Router attach, poll, send, and outage worker",
  },
  {
    name: "messaging",
    root: "transport/messaging",
    entrypoints: [
      "index.ts",
      {
        file: "address.ts",
        reason:
          "Registry resolution of a validated address, read without loading the engine",
      },
      {
        file: "errors.ts",
        reason:
          "Closed send, listen, and acknowledgment errors, read without loading the engine",
      },
      {
        file: "message.ts",
        reason: "Inbound message schemas, read without loading the engine",
      },
    ],
    reason: "Addressed send, GENESIS and POST certification, and recovery",
  },
  {
    name: "collectives",
    root: "transport/collectives",
    entrypoints: [
      "index.ts",
      {
        file: "forms.ts",
        reason:
          "Send forms and collective errors, read without loading the operation layer",
      },
      {
        file: "inbound.ts",
        reason:
          "Inbound item schemas, read without loading the operation layer",
      },
      {
        file: "message-text.ts",
        reason:
          "The message-text parser native hosts call, without loading the operation layer",
      },
    ],
    reason: "Gather and all_gather carried in posts",
  },
  {
    name: "delivery",
    root: "delivery",
    entrypoints: [
      "index.ts",
      {
        file: "operations.ts",
        reason:
          "The values harness operations take and return, decoded by hosts without loading the inbox or the store",
      },
      {
        file: "history-export.ts",
        reason:
          "The history export line schema hosts decode, without loading the inbox or the store",
      },
    ],
    reason:
      "The host inbox, send invocations, the delivery pass, the history export, and the operations hosts call on them",
  },
  {
    name: "endpoint",
    root: "endpoint",
    entrypoints: [
      "mcp/index.ts",
      "harness-endpoint/index.ts",
      {
        file: "implementation.ts",
        reason: "The package version both loopback MCP peers report",
      },
    ],
    reason:
      "The loopback MCP, owner tools, and the HarnessEndpoint hosts connect to",
  },
  {
    name: "service",
    root: "service",
    entrypoints: ["index.ts"],
    reason:
      "The always-on process: configuration, registration, supervision, and wiring",
  },
];

/**
 * A domain's non-index entrypoints are deliberate boundaries, so declaring
 * one with its reason also declares it a facade.
 */
const clientEntrypointFacades = clientDomains.flatMap(({ root, entrypoints }) =>
  entrypoints
    .filter((entry) => typeof entry !== "string")
    .map(({ file, reason }) => ({ file: `${root}/${file}`, reason })),
);

const packageDefinitions = {
  client: {
    beforeShared: {
      maxFolderCycles: 1,
      folderReadmeFileNames: ["README.md", "../README.md"],
      facadeFiles: clientEntrypointFacades,
      compositionRoots: [
        {
          path: "src/index.ts",
          reason:
            "Package facade: re-exports the adapter-facing values each domain owns",
        },
        {
          path: "src/index.types-check.ts",
          reason: "Type canary for the package facade's public types",
        },
        {
          path: "package.json",
          reason:
            "Package metadata whose version the loopback MCP peers report",
        },
      ],
      domains: clientDomains.map(({ name, root, entrypoints, reason }) => ({
        name,
        roots: [`src/${root}`],
        entrypoints: entrypoints.map(
          (entry) =>
            `src/${root}/${typeof entry === "string" ? entry : entry.file}`,
        ),
        reason,
      })),
      layers: clientDomains.toReversed().map(({ name, root, reason }) => ({
        name,
        folders: [root],
        reason,
      })),
    },
    afterShared: {
      publicTypePackages: [publicTypePackage.effect],
      allowedTestPublicSubpaths: [],
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
            file: "agent-key.ts",
            reason:
              "Domain entrypoint for the root-exported Ed25519 public key and signing authority; identity's artifact modules take the authority's signing and opening keys only from here",
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
          {
            file: "signed-message.ts",
            reason:
              "Domain entrypoint for the root-exported SignedMessage: signing, verification, the verified trust state, and the recipient order and bounds a sealed body inherits",
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
    ...(config.compositionRoots ?? []).map((entry) => entry.path),
    ...(config.domains ?? []).flatMap((domain) => [
      ...domain.roots,
      ...domain.entrypoints,
    ]),
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
      "Every facadeFiles.file, folderChildCountOverrides.folder,",
      "layers[].folders, compositionRoots.path, and domains root or",
      "entrypoint must name a real path. Fix the entry in",
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
