#!/usr/bin/env node
/**
 * @file Non-vacuous package architecture check. It proves the package
 * TypeScript project contains analyzable root files before delegating to the
 * architecture analyzer with the package-local configuration.
 *
 * Exit codes: 0 when the analyzer reports nothing, 1 when it reports a
 * finding, and 2 when the package cannot be analyzed at all, so an empty or
 * misconfigured project never passes as clean.
 */
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "@chughtapan/safer-architecture-lsp";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const requestedRoot = process.argv[2] ?? ".";
const projectRoot = path.resolve(requestedRoot);

const parsed = readPackageProject();
const { options, isolatedFolders } = readArchitectureOptions();
const program = createAnalysisProgram(parsed);
const analyzedFileCount = program
  .getSourceFiles()
  .filter(
    (sourceFile) =>
      isPackageFile(sourceFile.fileName) && !sourceFile.isDeclarationFile,
  ).length;
if (analyzedFileCount === 0) {
  cannotAnalyze(["architecture program contains no package source files"]);
}
report(
  analyzeResolvedArchitecture(options, () => program),
  analyzedFileCount,
  isolatedImports(program, isolatedFolders),
);

/**
 * Parse the package-local `tsconfig.json` and require that it enumerates at
 * least one package source file.
 */
function readPackageProject(): ts.ParsedCommandLine {
  const configPath = ts.findConfigFile(
    projectRoot,
    (fileName) => ts.sys.fileExists(fileName),
    "tsconfig.json",
  );
  if (configPath === undefined || !isPackageFile(configPath)) {
    return cannotAnalyze([
      `${requestedRoot} has no package-local tsconfig.json`,
    ]);
  }
  const configFile = ts.readConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (configFile.error !== undefined) {
    return cannotAnalyze([flatten(configFile.error)]);
  }
  const project = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (project.errors.length > 0) {
    return cannotAnalyze([
      project.errors.map((error) => flatten(error)).join("; "),
    ]);
  }
  if (!project.fileNames.some((fileName) => isPackageSourceFile(fileName))) {
    return cannotAnalyze([
      `${requestedRoot} tsconfig.json enumerates no package source files`,
    ]);
  }
  return project;
}

/**
 * Read `safer-architecture.config.json` and resolve it against the package
 * root. The analyzer validates the raw value itself, so it stays `unknown`
 * until then.
 */
function readArchitectureOptions() {
  const configPath = path.join(projectRoot, "safer-architecture.config.json");
  if (!existsSync(configPath)) {
    return cannotAnalyze([
      `${requestedRoot} has no safer-architecture.config.json`,
    ]);
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return cannotAnalyze(["invalid architecture config: not a JSON object"]);
    }
    return {
      options: resolveArchitectureOptions({ ...raw, projectRoot }, projectRoot),
      isolatedFolders: readIsolatedFolders(raw),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return cannotAnalyze([`invalid architecture config: ${detail}`]);
  }
}

/**
 * Build a no-emit program over the package sources. Emit-only options are
 * dropped so a composite build configuration cannot make analysis write.
 */
function createAnalysisProgram(project: ts.ParsedCommandLine): ts.Program {
  const compilerOptions = { ...project.options };
  delete compilerOptions.declarationMap;
  delete compilerOptions.sourceMap;
  delete compilerOptions.tsBuildInfoFile;
  return ts.createProgram(
    project.fileNames.filter((fileName) => isPackageSourceFile(fileName)),
    {
      ...compilerOptions,
      noEmit: true,
      composite: false,
      declaration: false,
      incremental: false,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
    },
  );
}

function report(
  architecture: ReturnType<typeof analyzeResolvedArchitecture>,
  analyzedFiles: number,
  isolated: readonly string[],
): never {
  const unavailable = architecture.diagnostics.filter(
    (diagnostic) => diagnostic.ruleId === "architecture-analysis-unavailable",
  );
  if (unavailable.length > 0) {
    return cannotAnalyze(unavailable.map(({ message }) => message));
  }
  for (const diagnostic of architecture.diagnostics) {
    const relativePath = path.relative(projectRoot, diagnostic.file);
    process.stdout.write(
      `${diagnostic.severity} ${diagnostic.ruleId} ${relativePath}: ${diagnostic.message}\n`,
    );
  }
  for (const diagnostic of isolated) {
    process.stdout.write(`error isolated-folder-import ${diagnostic}\n`);
  }
  const findingCount = architecture.diagnostics.length + isolated.length;
  process.stdout.write(
    `package architecture check: ${findingCount} finding(s) across ${analyzedFiles} analyzed file(s), ${architecture.waivers.length} waiver(s), options from file — ${projectRoot}\n`,
  );
  return process.exit(findingCount > 0 ? 1 : 0);
}

function isPackageSourceFile(fileName: string): boolean {
  return isPackageFile(fileName) && !fileName.endsWith(".d.ts");
}

/** True for a file inside the package and outside any `node_modules`. */
function isPackageFile(fileName: string): boolean {
  const absolutePath = path.resolve(fileName);
  return (
    absolutePath.startsWith(`${projectRoot}${path.sep}`) &&
    !absolutePath.includes(`${path.sep}node_modules${path.sep}`)
  );
}

function flatten(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "; ");
}

/** Isolation paths carry a reason just like the analyzer's other explicit boundary declarations. */
function readIsolatedFolders(raw: object): readonly string[] {
  const entries = "isolatedFolders" in raw ? raw.isolatedFolders : [];
  if (!Array.isArray(entries)) {
    return cannotAnalyze(["isolatedFolders must be an array"]);
  }
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      return cannotAnalyze(["isolatedFolders entries must be objects"]);
    }
    if (!("folder" in entry) || !nonEmptyText(entry.folder)) {
      return cannotAnalyze(["isolatedFolders entries require a folder"]);
    }
    if (!("reason" in entry) || !nonEmptyText(entry.reason)) {
      return cannotAnalyze(["isolatedFolders entries require a reason"]);
    }
    return entry.folder;
  });
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Isolated programs can import packages and their own files, never another source domain. */
function isolatedImports(
  program: ts.Program,
  folders: readonly string[],
): readonly string[] {
  return folders.flatMap((folder) => {
    const root = path.resolve(projectRoot, folder);
    return program
      .getSourceFiles()
      .filter((source) => source.fileName.startsWith(`${root}${path.sep}`))
      .flatMap((source) => importsOutside(program, source, root, folder));
  });
}

/** Resolve actual TypeScript targets so aliases cannot bypass a program's isolation. */
function importsOutside(
  program: ts.Program,
  source: ts.SourceFile,
  root: string,
  folder: string,
): readonly string[] {
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    const specifier = moduleSpecifier(node);
    if (
      specifier === undefined ||
      !(
        ts.isStringLiteral(specifier) ||
        ts.isNoSubstitutionTemplateLiteral(specifier)
      )
    ) {
      return;
    }
    const resolved = ts.resolveModuleName(
      specifier.text,
      source.fileName,
      program.getCompilerOptions(),
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (
      resolved !== undefined &&
      resolved.startsWith(`${projectRoot}${path.sep}src${path.sep}`) &&
      !resolved.startsWith(`${root}${path.sep}`)
    ) {
      findings.push(
        `${path.relative(projectRoot, source.fileName)} imports ${path.relative(projectRoot, resolved)} outside ${folder}`,
      );
    }
  };
  visit(source);
  return findings;
}

/** Static declarations, dynamic imports and import types all name source dependencies. */
function moduleSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return node.arguments[0];
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return node.argument.literal;
  }
  return undefined;
}

function cannotAnalyze(details: readonly string[]): never {
  for (const detail of details) {
    process.stderr.write(`cannot analyze: ${detail}\n`);
  }
  return process.exit(2);
}
