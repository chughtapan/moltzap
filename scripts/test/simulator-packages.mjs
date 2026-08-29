import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import {
  controllerExternalDependencies,
  controllerOverlayExternalDependencies,
  controllerOverlayPackageManifest,
  controllerPackageDependencies,
  controllerWorkspacePackageNames,
} from "../simulator/build-controller-image.mjs";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageRoot = join(workspaceRoot, "packages", "simulator");
const apiCensusPath = join(packageRoot, "api-census.json");
const packedConsumerPath = join(
  workspaceRoot,
  "scripts/test/fixtures/simulator-packed-consumer.ts",
);
const workspacePackageRoots = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
  "@moltzap/simulator": packageRoot,
});
const facadeSpecifiers = Object.freeze({
  ".": "@moltzap/simulator",
  "./network": "@moltzap/simulator/network",
  "./ledger": "@moltzap/simulator/ledger",
  "./agents": "@moltzap/simulator/agents",
});
const simulatorBaselineCommit = "102f110436bedbba828591c1b97fd4e322abcf76";
const baselineFacadeSources = Object.freeze({
  ".": "packages/simulator/src/index.ts",
  "./network": "packages/simulator/src/network.ts",
  "./ledger": "packages/simulator/src/ledger.ts",
  "./agents": "packages/simulator/src/agents.ts",
});
const expectedBaselineCounts = Object.freeze({
  ".": 70,
  "./network": 41,
  "./ledger": 40,
  "./agents": 45,
});
const admittedBaselineRemovals = Object.freeze({
  ".": Object.freeze([
    "ConversationOpened",
    "EndpointMessageReceived",
    "EndpointMessageSent",
    "LinkMessageDelayed",
    "LinkMessageDropped",
    "LinkMessageHeld",
    "MessageParts",
    "ReceivedMessage",
    "RouterMessageCommitted",
  ]),
  "./network": Object.freeze([
    "CommittedRouterMessage",
    "MessageParts",
    "OpenedConversation",
    "ReceivedMessage",
    "RouterSequence",
    "routerSequence",
  ]),
  "./ledger": Object.freeze([]),
  "./agents": Object.freeze([]),
});
const expectedCensusCounts = Object.freeze({
  ".": Object.freeze({ unique: 61, runtime: 40, types: 56 }),
  "./network": Object.freeze({ unique: 35, runtime: 18, types: 28 }),
  "./ledger": Object.freeze({ unique: 40 }),
  "./agents": Object.freeze({ unique: 45 }),
});
const controllerImageBuilder = join(
  workspaceRoot,
  "scripts",
  "simulator",
  "build-controller-image.mjs",
);
const controllerImageDockerfile = join(
  workspaceRoot,
  "scripts/simulator/controller-image/Dockerfile",
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-simulator-pack-"));
const forbiddenSimulatorPaths = [
  "dist/agents.d.ts",
  "dist/agents.d.ts.map",
  "dist/agents.js",
  "dist/agents.js.map",
  "dist/ledger.d.ts",
  "dist/ledger.d.ts.map",
  "dist/ledger.js",
  "dist/ledger.js.map",
  "dist/nanoclaw-assets",
  "dist/network.d.ts",
  "dist/network.d.ts.map",
  "dist/network.js",
  "dist/network.js.map",
  "nanoclaw-assets",
  "scripts/copy-nanoclaw-assets.mjs",
  "scripts/build-controller-image.mjs",
  "local/controller-image/Dockerfile",
  "src/layer.ts",
  "src/agents/cache.ts",
  "src/agents/effect.ts",
  "src/agents/nanoclaw/install.ts",
  "src/agents/nanoclaw/onecli.ts",
  "src/agents/nanoclaw/process.ts",
  "src/agents/openclaw/cache.ts",
  "src/agents/openclaw/process.ts",
  "src/agents.ts",
  "src/ledger.ts",
  "src/network.ts",
];
const forbiddenStandaloneWorkspacePaths = [
  "examples/simulator/README.md",
  "examples/simulator/hello.ts",
  "examples/simulator/openclaw-container.mjs",
  "examples/simulator/openclaw-container.test.mjs",
  "examples/simulator/openclaw-image.json",
  "examples/simulator/package.json",
  "examples/simulator/tsconfig.json",
];
const standaloneWorkspaceControlFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "knip.json",
  "tools/workspace/project.json",
  ".github/workflows/ci.yml",
];

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringArray(value, detail) {
  requireCondition(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    detail,
  );
  return value;
}

async function loadApiCensus() {
  const parsed = JSON.parse(await readFile(apiCensusPath, "utf8"));
  requireCondition(
    isRecord(parsed) &&
      parsed.schemaVersion === 2 &&
      isRecord(parsed.baseline) &&
      parsed.baseline.commit === simulatorBaselineCommit &&
      isRecord(parsed.baseline.removals) &&
      isRecord(parsed.facades),
    "simulator API census has an unsupported shape",
  );
  const facades = {};
  for (const subpath of Object.keys(facadeSpecifiers)) {
    const facade = parsed.facades[subpath];
    requireCondition(
      isRecord(facade) && typeof facade.declaration === "string",
      `simulator API census is missing ${subpath}`,
    );
    facades[subpath] = Object.freeze({
      declaration: facade.declaration,
      runtime: requireStringArray(
        facade.runtime,
        `simulator API census ${subpath}.runtime must be a string array`,
      ),
      types: requireStringArray(
        facade.types,
        `simulator API census ${subpath}.types must be a string array`,
      ),
    });
    requireCondition(
      JSON.stringify(facades[subpath].runtime) ===
        JSON.stringify(sortedNames(facades[subpath].runtime)) &&
        JSON.stringify(facades[subpath].types) ===
          JSON.stringify(sortedNames(facades[subpath].types)),
      `simulator API census ${subpath} names must be checked in sorted order`,
    );
  }
  requireCondition(
    JSON.stringify(Object.keys(parsed.facades)) ===
      JSON.stringify(Object.keys(facadeSpecifiers)),
    "simulator API census must contain exactly the four public facades",
  );
  for (const [subpath, expected] of Object.entries(expectedCensusCounts)) {
    const facade = facades[subpath];
    const unique = new Set([...facade.runtime, ...facade.types]).size;
    requireCondition(
      unique === expected.unique &&
        (expected.runtime === undefined ||
          facade.runtime.length === expected.runtime) &&
        (expected.types === undefined ||
          facade.types.length === expected.types),
      `simulator API census has the wrong admitted counts for ${subpath}`,
    );
  }
  await verifyBaselineDelta(parsed.baseline.removals, facades);
  return Object.freeze(facades);
}

function hasExportModifier(statement) {
  return statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function exportedVariableNames(statement) {
  if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
    return [];
  }
  return statement.declarationList.declarations.map((declaration) => {
    requireCondition(
      ts.isIdentifier(declaration.name),
      "simulator baseline facade uses an unsupported exported binding pattern",
    );
    return declaration.name.text;
  });
}

function exportedDeclarationName(statement) {
  if (
    !hasExportModifier(statement) ||
    !("name" in statement) ||
    statement.name === undefined ||
    !ts.isIdentifier(statement.name)
  ) {
    return [];
  }
  return [statement.name.text];
}

function facadeSourceExportNames(source, path) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      requireCondition(
        statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause),
        `simulator baseline facade ${path} must use named exports`,
      );
      names.push(
        ...statement.exportClause.elements.map((element) => element.name.text),
      );
      continue;
    }
    names.push(
      ...exportedVariableNames(statement),
      ...exportedDeclarationName(statement),
    );
  }
  return sortedNames(new Set(names));
}

async function baselineFacadeNames(subpath) {
  const sourcePath = baselineFacadeSources[subpath];
  const { stdout } = await exec(
    "git",
    ["show", `${simulatorBaselineCommit}:${sourcePath}`],
    { cwd: workspaceRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return facadeSourceExportNames(stdout, sourcePath);
}

async function verifyBaselineDelta(removals, facades) {
  requireCondition(
    JSON.stringify(Object.keys(removals)) ===
      JSON.stringify(Object.keys(baselineFacadeSources)),
    "simulator baseline removal map must contain exactly four facades",
  );
  for (const subpath of Object.keys(baselineFacadeSources)) {
    const declaredRemovals = requireStringArray(
      removals[subpath],
      `simulator baseline removals for ${subpath} must be a string array`,
    );
    requireCondition(
      JSON.stringify(declaredRemovals) ===
        JSON.stringify(admittedBaselineRemovals[subpath]),
      `simulator baseline removals drifted for ${subpath}`,
    );
    const baseline = await baselineFacadeNames(subpath);
    requireCondition(
      baseline.length === expectedBaselineCounts[subpath],
      `simulator immutable baseline has the wrong declaration count for ${subpath}`,
    );
    const removalSet = new Set(declaredRemovals);
    requireCondition(
      declaredRemovals.every((name) => baseline.includes(name)),
      `simulator removal map names a symbol absent from the immutable ${subpath} baseline`,
    );
    const expectedCurrent = baseline.filter((name) => !removalSet.has(name));
    const current = sortedNames(
      new Set([...facades[subpath].runtime, ...facades[subpath].types]),
    );
    requireCondition(
      JSON.stringify(current) === JSON.stringify(expectedCurrent),
      `simulator ${subpath} differs from its immutable baseline by more than the admitted removals`,
    );
  }
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

async function requirePathMissing(root, relativePath, detail) {
  try {
    await access(join(root, relativePath));
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }
    throw cause;
  }
  throw new Error(detail);
}

async function verifyRepositoryCutover() {
  await Promise.all(
    forbiddenStandaloneWorkspacePaths.map((relativePath) =>
      requirePathMissing(
        workspaceRoot,
        relativePath,
        `standalone simulator workspace path remains: ${relativePath}`,
      ),
    ),
  );
  await Promise.all(
    forbiddenSimulatorPaths.map((relativePath) =>
      requirePathMissing(
        packageRoot,
        relativePath,
        `obsolete simulator path remains in the repository: ${relativePath}`,
      ),
    ),
  );
  await Promise.all(
    standaloneWorkspaceControlFiles.map(async (relativePath) => {
      const source = await readFile(join(workspaceRoot, relativePath), "utf8");
      requireCondition(
        !source.includes("examples/simulator") &&
          !source.includes("simulator-example"),
        `standalone simulator workspace remains configured in ${relativePath}`,
      );
    }),
  );
}

async function verifyControllerImageAssembly() {
  const [dockerfile, channelPackageSource] = await Promise.all([
    readFile(controllerImageDockerfile, "utf8"),
    readFile(
      join(workspaceRoot, "packages", "openclaw-channel", "package.json"),
      "utf8",
    ),
  ]);
  const channelPackage = JSON.parse(channelPackageSource);
  const overlayPackage = controllerOverlayPackageManifest({
    "@moltzap/openclaw-channel": "moltzap-openclaw-channel.tgz",
  });

  requireCondition(
    JSON.stringify(controllerPackageDependencies) ===
      JSON.stringify([
        "@moltzap/client",
        "@moltzap/evals",
        "@moltzap/identity",
        "@moltzap/router",
        "@moltzap/simulator",
      ]),
    "the controller image must directly install evals and every production process binary",
  );
  requireCondition(
    JSON.stringify(controllerWorkspacePackageNames) ===
      JSON.stringify([
        "@moltzap/client",
        "@moltzap/evals",
        "@moltzap/openclaw-channel",
        "@moltzap/identity",
        "@moltzap/router",
        "@moltzap/simulator",
      ]),
    "the controller image must pack the complete production stack",
  );
  requireCondition(
    controllerExternalDependencies["@electric-sql/pglite"] === "0.4.4" &&
      controllerExternalDependencies["@electric-sql/pglite-socket"] ===
        "0.1.4" &&
      controllerExternalDependencies["@modelcontextprotocol/client"] ===
        "2.0.0-beta.5",
    "the controller image must install its Registry database and MCP registrar helpers",
  );
  requireCondition(
    JSON.stringify(controllerOverlayExternalDependencies) ===
      JSON.stringify({ openclaw: "2026.6.34" }) &&
      JSON.stringify(overlayPackage.dependencies) ===
        JSON.stringify({
          "@moltzap/openclaw-channel":
            "file:./tarballs/moltzap-openclaw-channel.tgz",
          openclaw: "2026.6.34",
        }),
    "the application overlay must install the exact OpenClaw host",
  );
  requireCondition(
    channelPackage.peerDependencies?.openclaw === "2026.6.34" &&
      channelPackage.peerDependenciesMeta?.openclaw?.optional === true &&
      channelPackage.dependencies?.openclaw === undefined,
    "the adapter must preserve its exact optional host peer without a runtime dependency edge",
  );
  requireCondition(
    /ENTRYPOINT \["node", "\/opt\/moltzap\/dist\/cluster\/controller\/main\.js"\]/.test(
      dockerfile,
    ),
    "controller image must start the compiled controller",
  );
  for (const expected of [
    "/opt/moltzap/application-overlay",
    "/opt/moltzap/dist",
    "/opt/moltzap/register-daemon.mjs",
    'await import("./node_modules/@moltzap/openclaw-channel/dist/openclaw-entry.js")',
    "cp -a node_modules/@moltzap/openclaw-channel/. /application-overlay/openclaw-channel/",
    "rm -rf node_modules/@moltzap/openclaw-channel",
    "cp -a node_modules /application-overlay/node_modules",
  ]) {
    requireCondition(
      dockerfile.includes(expected),
      `controller image is missing ${expected}`,
    );
  }
  requireCondition(
    /node:22\.22\.0-bookworm-slim@sha256:[0-9a-f]{64}/.test(dockerfile),
    "controller image base must be digest-pinned",
  );
  requireCondition(
    !dockerfile.includes("--omit=peer"),
    "controller overlay must install runtime peers",
  );
  await exec(process.execPath, ["--check", controllerImageBuilder], {
    cwd: workspaceRoot,
  });
}

async function packWorkspacePackage(packageDirectory, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageDirectory },
  );
  const printed = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  requireCondition(printed !== undefined, "pnpm pack returned no tarball");
  return resolve(packageDirectory, printed);
}

async function packedTarballs() {
  const destination = join(temporaryRoot, "tarballs");
  await mkdir(destination);
  return Object.fromEntries(
    await Promise.all(
      Object.entries(workspacePackageRoots).map(async ([name, root]) => [
        name,
        await packWorkspacePackage(root, destination),
      ]),
    ),
  );
}

async function verifyPackedFiles(extractedPackage) {
  const required = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/network/index.js",
    "dist/network/index.d.ts",
    "dist/ledger/index.js",
    "dist/ledger/index.d.ts",
    "dist/agents/index.js",
    "dist/agents/index.d.ts",
  ];
  await Promise.all(
    required.map(async (relativePath) => {
      const path = join(extractedPackage, relativePath);
      await readFile(path).catch((cause) => {
        throw new Error(`packed simulator is missing ${relativePath}`, {
          cause,
        });
      });
    }),
  );
  await Promise.all(
    forbiddenSimulatorPaths.map((relativePath) =>
      requirePathMissing(
        extractedPackage,
        relativePath,
        `packed simulator contains obsolete path ${relativePath}`,
      ),
    ),
  );

  const manifest = JSON.parse(
    await readFile(join(extractedPackage, "package.json"), "utf8"),
  );
  requireCondition(
    JSON.stringify(Object.keys(manifest.exports)) ===
      JSON.stringify([".", "./network", "./ledger", "./agents"]),
    "packed simulator exports must be root, network, ledger, and agents",
  );
  requireCondition(
    manifest.dependencies?.["@moltzap/openclaw-channel"] === undefined,
    "packed simulator must not depend on the OpenClaw adapter",
  );
}

function compareNames(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedNames(values) {
  return [...values].sort(compareNames);
}

function resolveAlias(checker, symbol) {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0
    ? symbol
    : checker.getAliasedSymbol(symbol);
}

function isTypeOnlyExport(symbol) {
  const declarations = symbol.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (ts.isExportSpecifier(declaration)) {
        return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
      }
      return ts.isExportDeclaration(declaration) && declaration.isTypeOnly;
    })
  );
}

function exportedSpaces(checker, sourceFile) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  requireCondition(
    moduleSymbol !== undefined,
    `declaration ${sourceFile.fileName} has no module symbol`,
  );
  const symbols = checker.getExportsOfModule(moduleSymbol);
  return Object.freeze({
    symbols: new Map(symbols.map((symbol) => [symbol.name, symbol])),
    runtime: sortedNames(
      symbols
        .filter(
          (symbol) =>
            !isTypeOnlyExport(symbol) &&
            (resolveAlias(checker, symbol).flags & ts.SymbolFlags.Value) !== 0,
        )
        .map((symbol) => symbol.name),
    ),
    types: sortedNames(
      symbols
        .filter(
          (symbol) =>
            (resolveAlias(checker, symbol).flags & ts.SymbolFlags.Type) !== 0,
        )
        .map((symbol) => symbol.name),
    ),
  });
}

function declaredProperties(checker, facade, symbolName) {
  const exported = facade.symbols.get(symbolName);
  requireCondition(
    exported !== undefined,
    `missing exported type ${symbolName}`,
  );
  const target = resolveAlias(checker, exported);
  return checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target));
}

function requireMembers(checker, facade, symbolName, expected) {
  const names = new Set(
    declaredProperties(checker, facade, symbolName).map(
      (property) => property.name,
    ),
  );
  for (const member of expected) {
    requireCondition(
      names.has(member),
      `${symbolName} must retain public member ${member}`,
    );
  }
}

function requireMembersAbsent(checker, facade, symbolName, forbidden) {
  const names = new Set(
    declaredProperties(checker, facade, symbolName).map(
      (property) => property.name,
    ),
  );
  for (const member of forbidden) {
    requireCondition(
      !names.has(member),
      `${symbolName} must not expose removed member ${member}`,
    );
  }
}

function requireSemanticMemberType(
  checker,
  facade,
  symbolName,
  memberName,
  requiredTypeName,
) {
  const member = declaredProperties(checker, facade, symbolName).find(
    (property) => property.name === memberName,
  );
  requireCondition(
    member !== undefined,
    `${symbolName} must retain public member ${memberName}`,
  );
  const declaration = member.valueDeclaration ?? member.declarations?.[0];
  requireCondition(
    declaration !== undefined,
    `${symbolName}.${memberName} has no declaration`,
  );
  const rendered = checker.typeToString(
    checker.getTypeOfSymbolAtLocation(member, declaration),
    declaration,
    ts.TypeFormatFlags.NoTruncation,
  );
  requireCondition(
    rendered.includes(requiredTypeName),
    `${symbolName}.${memberName} must be expressed in ${requiredTypeName}, got ${rendered}`,
  );
}

function verifyRemovedFamilies(checker, facades) {
  const forbiddenSymbols = [
    "CommittedRouterMessage",
    "EndpointMessageReceived",
    "EndpointMessageSent",
    "LinkMessageDelayed",
    "LinkMessageDropped",
    "LinkMessageHeld",
    "Message",
    "OpenedConversation",
    "ReceivedMessage",
    "RouterMessageCommitted",
    "RouterSequence",
  ];
  for (const [subpath, facade] of Object.entries(facades)) {
    for (const symbolName of forbiddenSymbols) {
      requireCondition(
        !facade.symbols.has(symbolName),
        `${subpath} must not expose removed symbol ${symbolName}`,
      );
    }
  }

  const network = facades["./network"];
  const agents = facades["./agents"];
  requireMembersAbsent(checker, network, "Endpoint", ["open"]);
  requireMembersAbsent(checker, network, "EndpointTransport", [
    "openConversation",
  ]);
  requireMembersAbsent(checker, network, "ConversationSocket", ["send"]);
  requireMembersAbsent(checker, network, "AgentConnection", [
    "connection",
    "key",
    "keys",
    "origins",
    "routerUrl",
    "store",
  ]);
  requireMembersAbsent(checker, network, "Router", [
    "attachAgent",
    "attachEndpoint",
  ]);
  requireMembersAbsent(checker, network, "RouterStopped", [
    "committedMessages",
  ]);
  requireMembersAbsent(checker, agents, "AgentRuntimeInput", [
    "connection",
    "key",
    "keys",
    "origins",
    "registryOrigin",
    "routerOrigin",
    "routerUrl",
    "store",
  ]);

  requireMembers(checker, network, "Endpoint", ["messages", "send", "socket"]);
  requireMembers(checker, facades["."], "Endpoint", [
    "messages",
    "send",
    "socket",
  ]);
  requireMembers(checker, network, "ConversationAddress", [
    "destination",
    "participants",
  ]);
  requireMembers(checker, facades["."], "ConversationAddress", [
    "destination",
    "participants",
  ]);
  requireMembers(checker, network, "EndpointTransport", ["received", "send"]);
  requireMembers(checker, network, "ConversationSocket", [
    "address",
    "endpoint",
    "messages",
    "receive",
  ]);
  requireMembers(checker, network, "AgentConnection", ["agent"]);
  requireMembers(checker, network, "Router", ["address", "stopped"]);
  requireMembers(checker, network, "LinkDelivery", ["from", "message", "to"]);
  requireMembers(checker, agents, "AgentRuntimeInput", ["agentName"]);
  requireMembers(checker, agents, "StartedAgent", [
    "agent",
    "gateway",
    "termination",
  ]);
  requireMembers(checker, facades["."], "RunSpec", [
    "agents",
    "cluster",
    "events",
    "execute",
    "id",
  ]);

  requireSemanticMemberType(
    checker,
    network,
    "Endpoint",
    "messages",
    "InboundDelivery",
  );
  requireSemanticMemberType(checker, network, "Endpoint", "send", "SendInput");
  requireSemanticMemberType(
    checker,
    facades["."],
    "Endpoint",
    "send",
    "SendInput",
  );
  requireSemanticMemberType(
    checker,
    network,
    "EndpointTransport",
    "received",
    "InboundDelivery",
  );
  requireSemanticMemberType(
    checker,
    network,
    "EndpointTransport",
    "send",
    "SendInput",
  );
  requireSemanticMemberType(
    checker,
    network,
    "ConversationSocket",
    "receive",
    "InboundDelivery",
  );
  requireSemanticMemberType(
    checker,
    network,
    "LinkDelivery",
    "message",
    "SignedMessage",
  );
}

function verifyDeclarationCensus(installedPackage, census) {
  const declarationPaths = Object.fromEntries(
    Object.entries(census).map(([subpath, facade]) => [
      subpath,
      join(installedPackage, facade.declaration),
    ]),
  );
  const program = ts.createProgram({
    rootNames: Object.values(declarationPaths),
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
    },
  });
  const checker = program.getTypeChecker();
  const facades = {};
  for (const [subpath, declarationPath] of Object.entries(declarationPaths)) {
    const sourceFile = program.getSourceFile(declarationPath);
    requireCondition(
      sourceFile !== undefined,
      `TypeScript did not load packed declaration ${declarationPath}`,
    );
    const actual = exportedSpaces(checker, sourceFile);
    const expected = census[subpath];
    requireCondition(
      JSON.stringify(actual.runtime) ===
        JSON.stringify(sortedNames(expected.runtime)),
      `${subpath} packed runtime declaration census drifted`,
    );
    requireCondition(
      JSON.stringify(actual.types) ===
        JSON.stringify(sortedNames(expected.types)),
      `${subpath} packed type declaration census drifted`,
    );
    facades[subpath] = actual;
  }
  verifyRemovedFamilies(checker, facades);
}

function localArchiveSpecifier(consumerRoot, archive) {
  return `file:${relative(consumerRoot, archive)}`;
}

async function verifyIsolatedInstall(consumerRoot) {
  const installedRoot = await realpath(consumerRoot);
  for (const packageName of [
    "@moltzap/client",
    "@moltzap/identity",
    "@moltzap/router",
    "@moltzap/simulator",
    "effect",
    "typescript",
  ]) {
    const installed = await realpath(
      join(consumerRoot, "node_modules", ...packageName.split("/")),
    );
    requireCondition(
      installed.startsWith(`${installedRoot}/`),
      `packed consumer resolved ${packageName} outside its isolated install`,
    );
  }
  const lockfile = await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8");
  requireCondition(
    !lockfile.includes(workspaceRoot) &&
      !lockfile.includes("workspace:") &&
      !lockfile.includes("link:"),
    "packed simulator consumer lockfile escaped to the source workspace",
  );
}

async function verifyConsumerImports(archives, census) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  const localPackages = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [
      name,
      localArchiveSpecifier(consumerRoot, archive),
    ]),
  );
  await Promise.all([
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "moltzap-simulator-packed-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: {
            ...localPackages,
            effect: "3.22.0",
          },
          devDependencies: {
            typescript: "6.0.2",
          },
          pnpm: {
            overrides: localPackages,
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "."',
        "overrides:",
        ...Object.entries(localPackages).map(
          ([name, specifier]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`,
        ),
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            lib: ["ES2023", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2023",
            verbatimModuleSyntax: true,
          },
          include: ["check.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    copyFile(packedConsumerPath, join(consumerRoot, "check.ts")),
    copyFile(apiCensusPath, join(consumerRoot, "api-census.json")),
  ]);
  await exec(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    { cwd: consumerRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  await verifyIsolatedInstall(consumerRoot);
  await exec(
    join(consumerRoot, "node_modules", ".bin", "tsc"),
    ["--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const installedSimulator = await realpath(
    join(consumerRoot, "node_modules", "@moltzap", "simulator"),
  );
  verifyDeclarationCensus(installedSimulator, census);

  const runtimeCheckPath = join(consumerRoot, "runtime-check.mjs");
  await writeFile(
    runtimeCheckPath,
    [
      'import { readFile } from "node:fs/promises";',
      'const census = JSON.parse(await readFile(new URL("./api-census.json", import.meta.url), "utf8"));',
      `const specifiers = ${JSON.stringify(facadeSpecifiers)};`,
      "for (const [subpath, specifier] of Object.entries(specifiers)) {",
      "  const api = await import(specifier);",
      "  const actual = Object.keys(api).sort();",
      "  const expected = [...census.facades[subpath].runtime].sort();",
      "  if (JSON.stringify(actual) !== JSON.stringify(expected)) {",
      '    throw new Error(`${subpath} runtime exports drifted: ${actual.join(", ")}`);',
      "  }",
      "}",
      'const client = await import("@moltzap/client");',
      'const identity = await import("@moltzap/identity");',
      'const simulator = await import("@moltzap/simulator");',
      'const network = await import("@moltzap/simulator/network");',
      'const { Schema } = await import("effect");',
      'const destination = Schema.decodeSync(client.MessageAddressInput)("agent:peer");',
      'const participant = network.makeParticipantHandle("observer", Schema.decodeSync(identity.AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA"));',
      "const participants = [participant];",
      "const address = new network.ConversationAddress(destination, participants);",
      "const rootAddress = new simulator.ConversationAddress(destination, participants);",
      "participants.push(participant);",
      'if (rootAddress.constructor !== address.constructor || address.destination !== destination || !Object.isFrozen(address) || !Object.isFrozen(address.participants) || address.participants.length !== 1) throw new Error("packed ConversationAddress does not preserve public immutable construction");',
      "let rejectedEmptyParticipants = false;",
      "try { new network.ConversationAddress(destination, []); } catch (cause) { rejectedEmptyParticipants = cause instanceof TypeError; }",
      'if (!rejectedEmptyParticipants) throw new Error("packed ConversationAddress accepted empty participants");',
      "let rejectedDuplicateParticipants = false;",
      "try { new network.ConversationAddress(destination, [participant, participant]); } catch (cause) { rejectedDuplicateParticipants = cause instanceof TypeError; }",
      'if (!rejectedDuplicateParticipants) throw new Error("packed ConversationAddress accepted duplicate participant identities");',
      "",
    ].join("\n"),
  );
  await exec(process.execPath, [runtimeCheckPath], {
    cwd: consumerRoot,
    env: { ...process.env, NODE_PATH: undefined },
    maxBuffer: 16 * 1024 * 1024,
  });
}

try {
  await verifyRepositoryCutover();
  await verifyControllerImageAssembly();
  const census = await loadApiCensus();
  const archives = await packedTarballs();
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", [
    "-xzf",
    archives["@moltzap/simulator"],
    "-C",
    extractedRoot,
  ]);
  const extractedPackage = join(extractedRoot, "package");
  await verifyPackedFiles(extractedPackage);
  await verifyConsumerImports(archives, census);
  process.stdout.write("simulator package consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
