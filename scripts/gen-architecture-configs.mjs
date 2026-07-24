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
  evals: {},
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
          file: "socket/server.ts",
          reason:
            "Stable server socket contract that composes transport and requirement layers behind MoltZapServer",
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
  testbed: {
    beforeShared: {
      packageRuntime: "node",
      maxPublicExports: 30,
      minPublicFacadeModules: 7,
      folderChildCountOverrides: [
        {
          folder: ".",
          maxChildren: 13,
          reason:
            "The testbed keeps runtime adapters, orchestration, readiness, process support, locking, and trace-capture modules as deliberate peers in its documented single-tier source layout",
        },
      ],
      facadeFiles: [
        {
          file: "channel-plugin-install.ts",
          reason:
            "Shared plugin-install and workspace-seed boundary both runtime adapters compose for on-disk channel provisioning",
        },
        {
          file: "testbed.ts",
          reason:
            "Public testbed boundary for adapter selection, coordinated runtime startup, process-signal interruption, and reverse-order teardown",
        },
        {
          file: "nanoclaw-adapter.ts",
          reason:
            "Nanoclaw runtime adapter boundary that composes installation, process lifecycle, and readiness behind the Runtime contract",
        },
        {
          file: "openclaw-adapter.ts",
          reason:
            "OpenClaw runtime adapter boundary that composes channel installation, process lifecycle, and readiness behind the Runtime contract",
        },
      ],
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

for (const [packageName, definition] of Object.entries(packageDefinitions)) {
  const config = definition.config ?? {
    ...definition.beforeShared,
    ...sharedConfig,
    ...definition.afterShared,
  };
  const configUrl = new URL(
    `packages/${packageName}/safer-architecture.config.json`,
    workspaceRoot,
  );

  await writeFile(configUrl, `${JSON.stringify(config, null, 2)}\n`);
}
