/**
 * @file Generates package-local architecture analyzer configurations.
 *
 * Every package's `safer-architecture.config.json` is written from the
 * definitions here. Generation fails, writing nothing, when any path an
 * allowance claims does not exist: the analyzer never complains about an
 * allowance whose target is gone, so a renamed or deleted path would keep
 * passing while guarding nothing.
 */
import { existsSync, writeFileSync } from "node:fs";

interface Allowance {
  readonly package: string;
  readonly reason: string;
}

interface TestSubpath {
  readonly subpath: string;
  readonly reason: string;
}

interface FacadeFile {
  readonly file: string;
  readonly reason: string;
}

interface ClientDomain {
  readonly name: string;
  /** Domain folder relative to `src/`. */
  readonly root: string;
  /** A bare string is the domain's index; an object is a facade with its reason. */
  readonly entrypoints: ReadonlyArray<string | FacadeFile>;
  readonly reason: string;
}

/** The analyzer configuration keys this generator writes, in emitted order. */
interface ArchitectureConfig {
  readonly packageRuntime?: string;
  readonly minExportedSiblingModules?: number;
  readonly maxPublicExports?: number;
  readonly minPublicFacadeModules?: number;
  readonly maxFolderCycles?: number;
  readonly publicTypePackages?: readonly Allowance[];
  readonly allowedTestPublicSubpaths?: readonly TestSubpath[];
  readonly folderReadmeFileNames?: readonly string[];
  readonly folderChildCountOverrides?: ReadonlyArray<{
    readonly folder: string;
    readonly maxChildren: number;
    readonly reason: string;
  }>;
  readonly facadeFiles?: readonly FacadeFile[];
  readonly compositionRoots?: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
  readonly domains?: ReadonlyArray<{
    readonly name: string;
    readonly roots: readonly string[];
    readonly entrypoints: readonly string[];
    readonly reason: string;
  }>;
  readonly layers?: ReadonlyArray<{
    readonly name: string;
    readonly folders: readonly string[];
    readonly reason: string;
  }>;
}

/**
 * A package either spells out its whole config or wraps the shared
 * allowances; `beforeShared` and `afterShared` keys land on either side of
 * them, which fixes the emitted key order.
 */
interface PackageDefinition {
  readonly config?: ArchitectureConfig;
  readonly beforeShared?: ArchitectureConfig;
  readonly afterShared?: ArchitectureConfig;
}

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

const publicTypePackages: readonly Allowance[] =
  Object.values(publicTypePackage);

const allowedTestPublicSubpaths: readonly TestSubpath[] = [
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

const sharedConfig: ArchitectureConfig = {
  publicTypePackages,
  allowedTestPublicSubpaths,
};

/**
 * The client's domains, lowest layer first. A domain may import only the
 * entrypoints of domains listed before it; the generator derives both the
 * CUPID domains and the layer order from this one list.
 */
const clientDomains: readonly ClientDomain[] = [
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
const clientEntrypointFacades: readonly FacadeFile[] = clientDomains.flatMap(
  ({ root, entrypoints }) =>
    entrypoints
      .filter((entry) => typeof entry !== "string")
      .map(({ file, reason }) => ({ file: `${root}/${file}`, reason })),
);

const packageDefinitions: Readonly<Record<string, PackageDefinition>> = {
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
          (entry) => `src/${root}/${entrypointFile(entry)}`,
        ),
        reason,
      })),
      layers: [...clientDomains].reverse().map(({ name, root, reason }) => ({
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

const architectureConfigDefinitions: ReadonlyArray<{
  readonly packageRoot: string;
  readonly definition: PackageDefinition;
}> = [
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
  process.stderr.write(
    `${[
      "Architecture config names paths that do not exist:",
      ...danglingClaims.map((claim) => `  ${claim}`),
      "",
      "Every facadeFiles.file, folderChildCountOverrides.folder,",
      "layers[].folders, compositionRoots.path, and domains root or",
      "entrypoint must name a real path. Fix the entry in",
      "scripts/architecture/gen-configs.ts or restore the path it claims.",
    ].join("\n")}\n`,
  );
  process.exit(1);
}

for (const { packageRoot, config } of resolved) {
  writeFileSync(
    new URL(`${packageRoot}/safer-architecture.config.json`, workspaceRoot),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function entrypointFile(entry: string | FacadeFile): string {
  return typeof entry === "string" ? entry : entry.file;
}

/** Every path the config claims, resolved the way the analyzer resolves it. */
function pathClaims(config: ArchitectureConfig): readonly string[] {
  return [
    ...(config.facadeFiles ?? []).map((entry) => facadePath(entry.file)),
    ...(config.folderChildCountOverrides ?? []).map((entry) =>
      folderPath(entry.folder),
    ),
    ...(config.layers ?? []).flatMap((layer) =>
      layer.folders.map((folder) => folderPath(folder)),
    ),
    ...(config.compositionRoots ?? []).map((entry) => entry.path),
    ...(config.domains ?? []).flatMap((domain) => [
      ...domain.roots,
      ...domain.entrypoints,
    ]),
  ];
}

/** A facade file is package-root relative and gains an implicit `src/`. */
function facadePath(file: string): string {
  const trimmed = file.replace(/^\.\//u, "");
  return trimmed.startsWith("src/") ? trimmed : `src/${trimmed}`;
}

/** A folder key is relative to `src/`, with `.` naming `src/` itself. */
function folderPath(folder: string): string {
  return folder === "." ? "src" : `src/${folder}`;
}
