import { execFile } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import {
  extractPackedArchive,
  installPackedConsumer,
  packWorkspaceClosure,
  requireCondition,
} from "./packed-workspace.mjs";

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
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-simulator-pack-"));

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
    isRecord(parsed) && parsed.schemaVersion === 3 && isRecord(parsed.facades),
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
  return Object.freeze(facades);
}

const SIMULATOR_EXECUTABLE = "bin/moltzap-sim";
const PROFILE_CLI_USAGE =
  "usage: moltzap-sim run --profile local|gke <spec.mjs>";

async function verifyPackedFiles(extractedPackage, manifest) {
  const required = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/network/index.js",
    "dist/network/index.d.ts",
    "dist/ledger/index.js",
    "dist/ledger/index.d.ts",
    "dist/agents/index.js",
    "dist/agents/index.d.ts",
    // What the executable reaches at run time: the profile modules it routes
    // to and the checked-in GKE profile the GKE module reads beside `dist`.
    "dist/cluster/profiles/cli.js",
    "dist/cluster/profiles/local.js",
    "dist/cluster/profiles/gke.js",
    "gke/profile.json",
    SIMULATOR_EXECUTABLE,
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

  requireCondition(
    JSON.stringify(Object.keys(manifest.exports)) ===
      JSON.stringify([".", "./network", "./ledger", "./agents"]),
    "packed simulator exports must be root, network, ledger, and agents",
  );
  requireCondition(
    manifest.bin?.["moltzap-sim"] === `./${SIMULATOR_EXECUTABLE}`,
    "packed simulator does not expose the moltzap-sim executable",
  );
  const executablePath = join(extractedPackage, SIMULATOR_EXECUTABLE);
  requireCondition(
    (await readFile(executablePath, "utf8")).startsWith(
      "#!/usr/bin/env node\n",
    ),
    "packed moltzap-sim executable has no Node shebang",
  );
  requireCondition(
    ((await stat(executablePath)).mode & 0o111) !== 0,
    "packed moltzap-sim executable is not executable",
  );
}

// The executable is the one thing in the tarball that resolves its own dist
// imports at run time, so it is started from the isolated install. A usage
// error is the cheapest proof that it loaded: it exercises every import and
// asks the cluster for nothing.
async function verifyExecutableStarts(consumerRoot) {
  const executable = join(
    consumerRoot,
    "node_modules",
    "@moltzap",
    "simulator",
    SIMULATOR_EXECUTABLE,
  );
  const outcome = await exec(process.execPath, [executable], {
    cwd: consumerRoot,
    env: { ...process.env, NODE_PATH: undefined },
  }).then(
    () => undefined,
    (failure) => failure,
  );
  requireCondition(
    outcome !== undefined && outcome.code === 1,
    `packed moltzap-sim did not refuse an empty command line: ${String(outcome?.stderr ?? outcome)}`,
  );
  requireCondition(
    String(outcome.stderr).includes(PROFILE_CLI_USAGE),
    `packed moltzap-sim did not print its usage: ${String(outcome.stderr)}`,
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

function verifyPublicContracts(checker, facades) {
  const network = facades["./network"];
  const agents = facades["./agents"];
  requireMembers(checker, network, "Endpoint", ["messages", "send"]);
  requireMembers(checker, facades["."], "Endpoint", ["messages", "send"]);
  requireMembers(checker, network, "EndpointTransport", ["received", "send"]);
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
  verifyPublicContracts(checker, facades);
}

async function verifyConsumerImports(archives, census) {
  const consumerRoot = await installPackedConsumer({
    temporaryRoot,
    workspaceRoot,
    name: "moltzap-simulator-packed-consumer",
    archives,
    dependencies: { effect: "3.22.0" },
    devDependencies: { typescript: "6.0.2" },
  });
  await verifyExecutableStarts(consumerRoot);
  await Promise.all([
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
  const census = await loadApiCensus();
  const { archives, manifests } = await packWorkspaceClosure(
    workspacePackageRoots,
    temporaryRoot,
  );
  await verifyPackedFiles(
    await extractPackedArchive(archives["@moltzap/simulator"], temporaryRoot),
    manifests["@moltzap/simulator"],
  );
  await verifyConsumerImports(archives, census);
  process.stdout.write("simulator package consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
