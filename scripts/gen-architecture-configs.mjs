import { writeFile } from "node:fs/promises";

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
  typebox: {
    package: "@sinclair/typebox",
    reason: "Schema runtime; types are the contract",
  },
  protocol: {
    package: "@moltzap/protocol",
    reason: "Intra-monorepo protocol; foundational shared contract",
  },
  client: {
    package: "@moltzap/client",
    reason: "Intra-monorepo client SDK; channels depend on its public surface",
  },
  simulator: {
    package: "@moltzap/simulator",
    reason:
      "Simulator contracts, implementations, and executable evaluations share one public package",
  },
};

const publicTypePackages = Object.entries(publicTypePackage)
  .filter(([name]) => name !== "simulator")
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
  {
    subpath: "./testing",
    reason:
      "Conformance + driver surface for cross-package integration testing",
  },
];

const sharedConfig = {
  publicTypePackages,
  allowedTestPublicSubpaths,
};

const packageDefinitions = {
  client: {
    beforeShared: {
      minExportedSiblingModules: 6,
      maxPublicExports: 29,
      minPublicFacadeModules: 8,
      folderChildCountOverrides: [
        {
          folder: ".",
          maxChildren: 25,
          maxChildrenIncludingTests: 27,
          reason:
            "The client SDK keeps its peer public surfaces and their focused implementation modules flat at the source root; AGENTS.md documents the package structure",
        },
      ],
      facadeFiles: [
        {
          file: "channel-core.ts",
          reason:
            "Named public boundary for channel-adapter dispatch, admission, and enrichment",
        },
        {
          file: "service.ts",
          reason:
            "Named public boundary for the managed MoltZap client service",
        },
        {
          file: "cli/transport.ts",
          reason:
            "Shared CLI transport contract composed by the individual command modules",
        },
        {
          file: "local-daemon-rpc.ts",
          reason:
            "Typed local-daemon IPC descriptor and codec boundary shared by the service, socket server, and CLI",
        },
        {
          file: "local-history.ts",
          reason:
            "Local history DTO, schema, and formatting boundary shared by the daemon RPC contract and service implementation",
        },
        {
          file: "profile.ts",
          reason:
            "Named-profile persistence contract shared by client configuration and CLI transport selection",
        },
      ],
    },
  },
  evals: {
    beforeShared: {
      maxPublicExports: 20,
      facadeFiles: [
        {
          file: "src/events.ts",
          reason:
            "Closed evaluation event catalog shared by episodes, transcript projection, and the simulator definition",
        },
        {
          file: "src/grading.ts",
          reason:
            "Evaluation-owned transcript, assessment, semantic judge, and calibration boundary",
        },
        {
          file: "src/sweep.ts",
          reason:
            "Durable report and sequential matrix execution boundary shared by the CLI and Phoenix publisher",
        },
      ],
    },
    afterShared: {
      publicTypePackages: [...publicTypePackages, publicTypePackage.simulator],
    },
  },
  "nanoclaw-channel": {
    beforeShared: {
      sharedFolderNames: [
        {
          folder: "db",
          reason:
            "Persistence helpers (agent/messaging groups, container configs) the moltzap channel adapter composes over.",
        },
        {
          folder: "modules",
          reason:
            "Cross-cutting modules (permissions) the channel adapter depends on.",
        },
      ],
    },
  },
  "openclaw-channel": {
    beforeShared: {
      packageRuntime: "node",
    },
  },
  protocol: {
    config: {
      minExportedSiblingModules: 10,
      maxSubpathExports: 11,
      maxPublicExports: 42,
      maxPublicReexports: 13,
      minPublicFacadeModules: 14,
      folderChildCountOverrides: [
        {
          folder: "transport",
          maxChildren: 12,
          reason:
            "Transport is a flat wire-contract toolkit whose descriptor, dispatch, mux, decoding, pagination, and wire-error modules form one cohesive lowest layer",
        },
      ],
      facadeFiles: [
        {
          file: "socket/lifecycle.ts",
          reason:
            "Stable lifecycle contract shared by the agent and app socket clients while socket/index.ts curates the published socket surface",
        },
        {
          file: "socket/client-runtime.config.ts",
          reason:
            "Internal managed-runtime boot policy that sends protocol diagnostics to stderr so client applications can reserve stdout for structured output",
        },
        {
          file: "socket/server.ts",
          reason:
            "Stable server socket contract that composes transport and requirement layers behind MoltZapServer",
        },
        {
          file: "identity/agents/types.ts",
          reason:
            "Agent record schemas and validation form the identity descriptor boundary consumed by the agent-list RPC while identity/agents/index.ts curates the published surface",
        },
        {
          file: "task/tasks.ts",
          reason:
            "Task value schemas, errors, RPC descriptors, and notification catalogs form one protocol-domain boundary while task/index.ts curates the published surface",
        },
        {
          file: "task/requirements/task-read-access.ts",
          reason:
            "TaskReadAccess is the task-domain capability boundary consumed by descriptors and implemented by the server",
        },
        {
          file: "transport/definition.ts",
          reason:
            "Descriptor definitions are the stable transport boundary used by every higher protocol domain",
        },
      ],
      publicTypePackages: [
        publicTypePackage.effect,
        publicTypePackage.platform,
        publicTypePackage.platformNode,
        {
          package: "@effect/rpc",
          reason:
            "RPC definitions are the protocol's public contract; Rpc/RpcGroup types cross the boundary by design",
        },
        publicTypePackage.typebox,
      ],
      allowedTestPublicSubpaths: [
        {
          subpath: "./testing",
          reason:
            "Conformance + driver surface for cross-package integration testing; consumed by moltzap-arena",
        },
      ],
      layers: [
        {
          name: "engine",
          folders: ["engine"],
          reason:
            "RpcServer engine + descriptor-aggregate; couples to the full rpc-registry catalog + task-layer capability tags, so it sits above the domains",
        },
        {
          name: "app",
          folders: ["app"],
          reason:
            "Composition layer: app RPCs composed over task, network, identity, transport descriptors",
        },
        {
          name: "task",
          folders: ["task"],
          reason:
            "Task domain: conversations, messages, dispatch, TM authority",
        },
        {
          name: "network",
          folders: ["network"],
          reason:
            "Network domain: ping, presence, connection liveness, actor-model types",
        },
        {
          name: "identity",
          folders: ["identity"],
          reason: "Identity domain: agents, users, sessions, contact policy",
        },
        {
          name: "transport",
          folders: ["transport"],
          reason:
            "Wire layer: Ajv frames, RpcDefinition primitives, dispatch; no domain semantics",
        },
      ],
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
      facadeFiles: [
        {
          file: "network.ts",
          reason:
            "Published network contract for participants, conversations, endpoints, links, and router implementations",
        },
        {
          file: "ledger.ts",
          reason:
            "Published ledger contract for records, storage, live runs, and offline inspection",
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
          file: "kernel/event-services.ts",
          reason:
            "Definition-bound Effect services for readable ledgers and customer-owned event emission",
        },
        {
          file: "ledger/model.ts",
          reason:
            "Durable record, manifest, completion, digest, and ledger-reference model",
        },
        {
          file: "ledger/storage.ts",
          reason:
            "Storage port that keeps allocation, append, completion, and reading independent of the filesystem implementation",
        },
        {
          file: "ledger/live.ts",
          reason:
            "Live-ledger boundary for ordered append, failure latching, completion, and typed event streams",
        },
        {
          file: "ledger/open.ts",
          reason: "Completed-ledger validation and offline opening boundary",
        },
        {
          file: "kernel/outcomes.ts",
          reason:
            "Causal outcome conversion shared by runtime, router, and program lifecycle modules",
        },
        {
          file: "kernel/router.ts",
          reason:
            "Router lifecycle boundary coupling scoped acquisition and shutdown with durable causal outcomes",
        },
        {
          file: "kernel/run.ts",
          reason:
            "Run boundary composing definitions, scoped resources, lifecycle outcomes, and the customer Effect",
        },
        {
          file: "network/endpoint.ts",
          reason:
            "Controlled endpoint and network service boundary over router transports and conversation receive cursors",
        },
        {
          file: "network/link.ts",
          reason:
            "Link driver port and experiment-facing scoped link controller services",
        },
        {
          file: "network/participant.ts",
          reason:
            "Nominal participant and agent handles shared by network, runtime, and kernel capabilities",
        },
        {
          file: "network/conversation.ts",
          reason: "Conversation addressing and endpoint-bound socket contract",
        },
        {
          file: "network/router.ts",
          reason:
            "Router port, framed message model, connection contract, and typed network failures",
        },
        {
          file: "network/server.ts",
          reason:
            "Scoped MoltZap server ownership for image, storage, process, observation, and identity resources",
        },
        {
          file: "runtime/runtime.ts",
          reason:
            "Autonomous participant lifecycle contract implemented by every runtime family",
        },
        {
          file: "runtime/roster.ts",
          reason:
            "Keyed mixed-runtime roster preserving each agent's acquisition errors and Effect requirements",
        },
        {
          file: "runtime/process.ts",
          reason:
            "Scoped process bridge shared by the external runtime implementations",
        },
        {
          file: "runtime/packages.ts",
          reason:
            "Runtime package discovery and install-policy boundary shared by shipped runtime families",
        },
        {
          file: "runtime/nanoclaw/install.ts",
          reason:
            "NanoClaw installation boundary composing source acquisition, package assets, and dependency materialization",
        },
        {
          file: "runtime/openclaw/process.ts",
          reason:
            "OpenClaw process boundary composing workspace setup, channel materialization, gateway configuration, port ownership, and supervised lifetime",
        },
      ],
      layers: [
        {
          name: "kernel",
          folders: ["kernel"],
          reason:
            "The run kernel orchestrates capability contracts without becoming a dependency of them",
        },
        {
          name: "capabilities",
          folders: ["events", "ledger", "network", "runtime"],
          reason:
            "Peer event, ledger, network, and runtime capabilities compose through typed ports and do not form a truthful linear stack",
        },
      ],
    },
    afterShared: {
      publicTypePackages: [
        publicTypePackage.effect,
        publicTypePackage.platform,
        publicTypePackage.protocol,
      ],
      allowedTestPublicSubpaths: [],
    },
  },
  server: {
    beforeShared: {
      packageRuntime: "node",
    },
    afterShared: {
      minExportedSiblingModules: 7,
      folderChildCountOverrides: [
        {
          folder: ".",
          maxChildren: 13,
          reason:
            "The source root is the package assembly boundary and intentionally groups its domain folders with the binary and configuration entrypoints",
        },
        {
          folder: "db",
          maxChildren: 11,
          reason:
            "The database boundary keeps schema, client, migration, and crypto adapters together while each concern remains named and cohesive",
        },
      ],
      facadeFiles: [
        {
          file: "db/crypto/envelope.ts",
          reason:
            "Envelope encryption is the crypto subsystem's explicit API over its key-material implementation files",
        },
        {
          file: "dispatch/layer.ts",
          reason:
            "The dispatch layer module is the composition facade for its Effect service tags and live implementations",
        },
        {
          file: "message/layer.ts",
          reason:
            "The message layer module is the composition facade for its Effect service tags and live implementations",
        },
        {
          file: "network/layer.ts",
          reason:
            "The network layer module is the composition facade for its Effect service tags and live implementations",
        },
        {
          file: "task/layer.ts",
          reason:
            "The task layer module is the composition facade for its Effect service tags and live implementations",
        },
        {
          file: "dispatch/lease-registry.ts",
          reason:
            "The lease registry module is the authoritative facade for the complete dispatch lease state machine and its wire projection",
        },
        {
          file: "moltzap/handler-catalog.ts",
          reason:
            "The handler catalog is the explicit adapter facade that binds domain handlers to protocol method tags",
        },
      ],
    },
  },
};

const workspaceRoot = new URL("../", import.meta.url);

const architectureConfigDefinitions = [
  ...Object.entries(packageDefinitions).map(([packageName, definition]) => ({
    packageRoot: `packages/${packageName}`,
    definition,
  })),
  {
    packageRoot: "v2/identity",
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
              "The identity root keeps its closed identifier, key, signed-artifact, request-authentication, and Registry capability boundaries as peer deep modules",
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
              "Production process-composition boundary exported through the server subpath",
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
    packageRoot: "v2/router",
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
            maxChildren: 12,
            reason:
              "The Router implementation keeps contract, client, RPC, HTTP, send, poll, feed, cursor, waiters, configuration, server, and process as the cohesive boundaries of one independently runnable service",
          },
        ],
        facadeFiles: [
          {
            file: "router/client.ts",
            reason:
              "Private HTTP client boundary used by the public Router capability",
          },
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
          {
            file: "router/server.ts",
            reason:
              "Production process-composition boundary exported through the server subpath",
          },
        ],
      },
    },
  },
];

for (const { packageRoot, definition } of architectureConfigDefinitions) {
  const config = definition.config ?? {
    ...definition.beforeShared,
    ...sharedConfig,
    ...definition.afterShared,
  };
  const configUrl = new URL(
    `${packageRoot}/safer-architecture.config.json`,
    workspaceRoot,
  );

  await writeFile(configUrl, `${JSON.stringify(config, null, 2)}\n`);
}
