#!/usr/bin/env node
/**
 * @file Non-vacuous package architecture check. It proves the package
 * TypeScript project contains analyzable root files before delegating to the
 * architecture analyzer with the package-local configuration.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeResolvedArchitecture,
  resolveArchitectureOptions,
} from "@chughtapan/safer-architecture-lsp";
import ts from "typescript";

const requestedRoot = process.argv[2] ?? ".";
const projectRoot = path.resolve(requestedRoot);
const configPath = ts.findConfigFile(
  projectRoot,
  ts.sys.fileExists,
  "tsconfig.json",
);

if (
  configPath === undefined ||
  !configPath.startsWith(`${projectRoot}${path.sep}`)
) {
  process.stderr.write(
    `cannot analyze: ${requestedRoot} has no package-local tsconfig.json\n`,
  );
  process.exit(2);
}

const architectureConfigPath = path.join(
  projectRoot,
  "safer-architecture.config.json",
);
if (!existsSync(architectureConfigPath)) {
  process.stderr.write(
    `cannot analyze: ${requestedRoot} has no safer-architecture.config.json\n`,
  );
  process.exit(2);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error !== undefined) {
  process.stderr.write(
    `cannot analyze: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "; ")}\n`,
  );
  process.exit(2);
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.dirname(configPath),
);
if (parsed.errors.length > 0) {
  const detail = parsed.errors
    .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "; "))
    .join("; ");
  process.stderr.write(`cannot analyze: ${detail}\n`);
  process.exit(2);
}

const sourceFiles = parsed.fileNames.filter((fileName) => {
  const absolutePath = path.resolve(fileName);
  return (
    absolutePath.startsWith(`${projectRoot}${path.sep}`) &&
    !absolutePath.includes(`${path.sep}node_modules${path.sep}`) &&
    !absolutePath.endsWith(".d.ts")
  );
});
if (sourceFiles.length === 0) {
  process.stderr.write(
    `cannot analyze: ${requestedRoot} tsconfig.json enumerates no package source files\n`,
  );
  process.exit(2);
}

let architectureConfig;
try {
  architectureConfig = JSON.parse(readFileSync(architectureConfigPath, "utf8"));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `cannot analyze: invalid architecture config: ${detail}\n`,
  );
  process.exit(2);
}

let options;
try {
  options = resolveArchitectureOptions(
    { ...architectureConfig, projectRoot },
    projectRoot,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `cannot analyze: invalid architecture config: ${detail}\n`,
  );
  process.exit(2);
}

const compilerOptions = { ...parsed.options };
delete compilerOptions.declarationMap;
delete compilerOptions.sourceMap;
delete compilerOptions.tsBuildInfoFile;
const program = ts.createProgram(sourceFiles, {
  ...compilerOptions,
  noEmit: true,
  composite: false,
  declaration: false,
  incremental: false,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
});
const analyzedSourceFiles = program.getSourceFiles().filter((sourceFile) => {
  const absolutePath = path.resolve(sourceFile.fileName);
  return (
    absolutePath.startsWith(`${projectRoot}${path.sep}`) &&
    !absolutePath.includes(`${path.sep}node_modules${path.sep}`) &&
    !sourceFile.isDeclarationFile
  );
});
if (analyzedSourceFiles.length === 0) {
  process.stderr.write(
    `cannot analyze: architecture program contains no package source files\n`,
  );
  process.exit(2);
}

const report = analyzeResolvedArchitecture(options, () => program);
const unavailable = report.diagnostics.filter(
  (diagnostic) => diagnostic.ruleId === "architecture-analysis-unavailable",
);
if (unavailable.length > 0) {
  for (const diagnostic of unavailable) {
    process.stderr.write(`cannot analyze: ${diagnostic.message}\n`);
  }
  process.exit(2);
}
for (const diagnostic of report.diagnostics) {
  const relativePath = path.relative(projectRoot, diagnostic.file);
  process.stdout.write(
    `${diagnostic.severity} ${diagnostic.ruleId} ${relativePath}: ${diagnostic.message}\n`,
  );
}

process.stdout.write(
  `package architecture check: ${report.diagnostics.length} finding(s) across ${analyzedSourceFiles.length} analyzed file(s), ${report.waivers.length} waiver(s), options from file — ${projectRoot}\n`,
);
process.exit(report.diagnostics.length > 0 ? 1 : 0);
