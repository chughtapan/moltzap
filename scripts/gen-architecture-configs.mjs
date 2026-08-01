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
  protocol: {
    package: "@moltzap/protocol",
    reason: "Intra-monorepo protocol; foundational shared contract",
  },
  client: {
    package: "@moltzap/client",
    reason: "Intra-monorepo client SDK; channels depend on its public surface",
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
  .filter(([name]) => name !== "openclaw" && name !== "simulator")
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
      // channel-base names the adapter primitives, and BoundedMap is one of
      // them; the rule counts local re-exports, so owning that module in-package
      // rather than importing it raises the count without widening the contract.
      minPublicFacadeModules: 9,
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
          file: "src/grading.ts",
          reason:
            "Evaluation-owned transcript, assessment, semantic judge, and calibration boundary",
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
          file: "src/peer.ts",
          reason:
            "Autonomous Effect peer policies and observation gateways form the bundled social-peer boundary",
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
        publicTypePackage.protocol,
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
      maxPublicExports: 43,
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
          name: "socket",
          folders: ["socket"],
          reason:
            "Composition layer: the clients, the server, and the catalog that derives its RPC groups from every domain below it",
        },
        {
          name: "message",
          folders: ["message"],
          reason:
            "Message domain: payloads, send and list descriptors, dispatch admission; addresses conversations, so it sits above them",
        },
        {
          name: "conversation",
          folders: ["conversation"],
          reason:
            "Conversation domain: addressing, participant membership, and the identifiers the message domain references",
        },
        {
          name: "network",
          folders: ["network"],
          reason:
            "Network domain: connect descriptors, protocol version, and the server address",
        },
        {
          name: "identity",
          folders: ["identity"],
          reason:
            "Identity domain: agents, apps, users, and the principal requirements every domain above composes",
        },
        {
          name: "transport",
          folders: ["transport"],
          reason:
            "Wire layer: descriptor primitives, strict decode, mux routing, tagged errors; no domain semantics",
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
          file: "runtime.ts",
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
          file: "kernel/link-fabric.ts",
          reason:
            "Link-fabric boundary coupling the platform link driver, receiver registration, and the policy interpreter",
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
        {
          ...publicTypePackage.rpc,
          reason:
            "Effect RPC types cross the autonomous runtime-builder boundary through the production MoltZap agent client",
        },
        publicTypePackage.openclaw,
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
      "scripts/gen-architecture-configs.mjs or restore the path it claims.",
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
