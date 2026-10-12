/**
 * @file Source-text rules of the architecture boundary check: shared
 * `packages/*` export and barrel discipline, the documentation-only layer
 * notation, and the import rules that hold each product to its final DAG.
 *
 * Every rule asserts its input set is non-empty before reporting success. A
 * check that walks nothing passes vacuously and is indistinguishable from no
 * check at all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dependencyNames,
  FINAL_PACKAGE_DIRS,
  FINAL_PACKAGES,
  type PackageDir,
} from "./boundary-contract.ts";
import {
  type BoundaryRun,
  fail,
  lineAt,
  relativePath,
  walkFiles,
} from "./boundary-run.ts";

/** One module specifier and where it starts in the source text. */
interface ImportSpecifier {
  readonly specifier: string;
  readonly index: number;
}

/** One file of one product whose imports are being checked. */
interface ImportSite {
  readonly dir: PackageDir;
  readonly packageDirectory: string;
  readonly file: string;
  readonly text: string;
}

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "dist",
  "node_modules",
]);

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const CORE_SERVICE_TAGS =
  /\b(DbTag|EncryptionTag|ConnectionTag|ConnectionManagerTag|AgentEndpointResolverTag|NetworkSendServiceTag|AuthServiceTag|AppAuthServiceTag|AppEndpointRegistryTag|ContactsServiceTag|ConversationServiceTag|PresenceServiceTag|LeaseRegistryTag|DispatchAdmissionServiceTag|MessageServiceTag|TaskAuthorizationServiceTag|TaskServiceTag)\b/;

/**
 * Architectural numbering helps readers navigate specifications, but it
 * obscures domain ownership in executable artifacts. Source and package
 * metadata name identity, Registry, router, and Router directly.
 */
const LAYER_NOTATION_SOURCE = String.raw`(?:^|[^A-Za-z0-9])(?:[Ll][12](?=$|[^a-z0-9])|[Ll]ayer(?:[ _-]?(?:[12]|[Oo]ne|[Tt]wo))(?=$|[^a-z0-9]))`;

/**
 * Static, dynamic, re-export, and bare side-effect imports all name a module.
 * Missing any one form would let a violating import in through that keyword.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/**
 * Apply the shared wildcard-export and `#core` barrel rules to every package
 * TypeScript source.
 * @param run Run collecting failures.
 * @returns How many sources were scanned.
 */
export function checkSharedSourceRules(run: BoundaryRun): number {
  const sourceFiles = walkFiles(
    run.packagesRoot,
    (name) => name.endsWith(".ts"),
    SKIPPED_DIRECTORIES,
  );
  if (sourceFiles.length === 0) {
    run.failures.push(
      "packages/: no TypeScript sources scanned; shared rules would pass vacuously",
    );
  }
  for (const file of sourceFiles) {
    checkSourceFile(run, file);
  }
  return sourceFiles.length;
}

/**
 * Fail any numbered layer notation in Identity and Router file paths or
 * non-documentation file text.
 * @param run Run collecting failures.
 * @returns How many non-documentation files were scanned.
 */
export function checkLayerVocabulary(run: BoundaryRun): number {
  let scanned = 0;
  for (const dir of ["identity", "router"]) {
    const files = walkFiles(
      path.join(run.packagesRoot, dir),
      (name) => path.extname(name) !== ".md" && path.extname(name) !== ".mdx",
      new Set([...SKIPPED_DIRECTORIES, ".eslintcache"]),
    );
    if (files.length === 0) {
      run.failures.push(
        `packages/${dir}: no non-documentation files scanned; the vocabulary rule would pass vacuously here`,
      );
      continue;
    }
    scanned += files.length;
    for (const file of files) {
      checkLayerNotation(run, file);
    }
  }
  return scanned;
}

/**
 * Hold every product's imports to its final DAG, its dependencies' public
 * exports, and its own directory.
 * @param run Run collecting failures.
 * @returns How many product code files were scanned.
 */
export function checkFinalImports(run: BoundaryRun): number {
  let scanned = 0;
  for (const dir of FINAL_PACKAGE_DIRS) {
    const packageDirectory = path.join(run.packagesRoot, dir);
    const files = walkFiles(
      packageDirectory,
      (name) => CODE_EXTENSIONS.has(path.extname(name)),
      SKIPPED_DIRECTORIES,
    );
    if (files.length === 0) {
      run.failures.push(
        `packages/${dir}: no code files scanned; import rules would pass vacuously here`,
      );
      continue;
    }
    scanned += files.length;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      checkImports(run, { dir, packageDirectory, file, text });
    }
  }
  return scanned;
}

function checkSourceFile(run: BoundaryRun, file: string): void {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/export\s+\*\s+from\s+["'][^"']+["']/g)) {
    fail(
      run,
      file,
      lineAt(text, match.index),
      "wildcard export is not allowed",
    );
  }
  for (const match of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']#core["']/g,
  )) {
    if (CORE_SERVICE_TAGS.test(match[1] ?? "")) {
      fail(
        run,
        file,
        lineAt(text, match.index),
        "domain/socket/db service tags must import from their owning barrel, not #core",
      );
    }
  }
}

function checkLayerNotation(run: BoundaryRun, file: string): void {
  const relative = relativePath(run, file);
  if (new RegExp(LAYER_NOTATION_SOURCE).test(relative)) {
    run.failures.push(
      `${relative}: numbered architecture notation is documentation-only`,
    );
  }
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(new RegExp(LAYER_NOTATION_SOURCE, "g"))) {
    fail(
      run,
      file,
      lineAt(text, match.index),
      "numbered architecture notation is documentation-only; name the owning domain",
    );
  }
}

function checkImports(run: BoundaryRun, site: ImportSite): void {
  for (const { specifier, index } of importSpecifiers(site.text)) {
    const line = lineAt(site.text, index);
    const root = packageRoot(specifier);
    if (root.startsWith("@moltzap/")) {
      checkProductImport(run, site, specifier, line);
    }
    if (
      specifier.startsWith(".") &&
      !isInsidePackage(
        run,
        site,
        path.resolve(path.dirname(site.file), specifier),
      )
    ) {
      fail(
        run,
        site.file,
        line,
        `package must not cross its boundary by relative path ("${specifier}")`,
      );
    }
  }
}

function checkProductImport(
  run: BoundaryRun,
  site: ImportSite,
  specifier: string,
  line: number,
): void {
  const root = packageRoot(specifier);
  const target = FINAL_PACKAGE_DIRS.find(
    (dir) => FINAL_PACKAGES[dir].npmName === root,
  );
  if (target === undefined) {
    fail(run, site.file, line, `unknown MoltZap package import "${root}"`);
    return;
  }
  if (!mayImport(site.dir, root)) {
    fail(
      run,
      site.file,
      line,
      `dependency DAG violation: "${site.dir}" may not import "${root}"`,
    );
    return;
  }
  const subpath = exportSubpath(specifier, root);
  if (!Object.hasOwn(FINAL_PACKAGES[target].exports, subpath)) {
    fail(
      run,
      site.file,
      line,
      `import "${specifier}" is not a public export of "${root}"`,
    );
  }
  if (
    isRuntimeAdapter(site.dir) &&
    root === "@moltzap/client" &&
    subpath !== "."
  ) {
    fail(
      run,
      site.file,
      line,
      "runtime adapter must import only the @moltzap/client root",
    );
  }
}

function mayImport(dir: PackageDir, root: string): boolean {
  return (
    root === FINAL_PACKAGES[dir].npmName || dependencyNames(dir).includes(root)
  );
}

function exportSubpath(specifier: string, root: string): string {
  return specifier === root ? "." : `.${specifier.slice(root.length)}`;
}

function isRuntimeAdapter(dir: PackageDir): boolean {
  return dir === "openclaw-channel" || dir === "nanoclaw-channel";
}

/**
 * Whether a resolved relative import stays inside its package, or names one
 * of the shared root configuration modules every package config loads.
 */
function isInsidePackage(
  run: BoundaryRun,
  site: ImportSite,
  resolved: string,
): boolean {
  return (
    sharedPackageConfigImports(run).has(resolved) ||
    resolved === site.packageDirectory ||
    resolved.startsWith(`${site.packageDirectory}${path.sep}`)
  );
}

/**
 * The resolved specifiers of the root modules package configurations share.
 * Package code imports them by their emitted `.js` name.
 */
function sharedPackageConfigImports(run: BoundaryRun): ReadonlySet<string> {
  return new Set([
    path.join(run.repo, "eslint.shared.js"),
    path.join(run.repo, "vitest.workspace-aliases.js"),
  ]);
}

function importSpecifiers(text: string): readonly ImportSpecifier[] {
  return [...text.matchAll(IMPORT_SPECIFIER)].map((match) => ({
    specifier: match[1] ?? "",
    index: match.index,
  }));
}

/** The package a specifier addresses, ignoring any subpath export. */
function packageRoot(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2
      ? `${parts[0] ?? ""}/${parts[1] ?? ""}`
      : specifier;
  }
  return parts[0] ?? specifier;
}
