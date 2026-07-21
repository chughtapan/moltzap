#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const repo = process.cwd();
const failures = [];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

function rel(file) {
  return path.relative(repo, file);
}

function lineAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`);
}

function checkSourceFile(file) {
  const text = fs.readFileSync(file, "utf8");

  for (const match of text.matchAll(/export\s+\*\s+from\s+["'][^"']+["']/g)) {
    fail(file, lineAt(text, match.index), "wildcard export is not allowed");
  }

  for (const match of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']#transport["']/g,
  )) {
    const names = match[1];
    if (
      /\b(defineRpc|defineNotification|decodeRpcResult|effectiveErrorClasses|jsonRpcMethod)\b/.test(
        names,
      )
    ) {
      fail(
        file,
        lineAt(text, match.index),
        "descriptor construction must import from #transport/descriptor",
      );
    }
  }

  for (const match of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']#core["']/g,
  )) {
    const names = match[1];
    if (
      /\b(DbTag|EncryptionTag|ConnectionTag|ConnectionManagerTag|AgentEndpointResolverTag|NetworkSendServiceTag|AuthServiceTag|AppAuthServiceTag|AppEndpointRegistryTag|ContactsServiceTag|ConversationServiceTag|PresenceServiceTag|LeaseRegistryTag|DispatchAdmissionServiceTag|MessageServiceTag|TaskAuthorizationServiceTag|TaskServiceTag)\b/.test(
        names,
      )
    ) {
      fail(
        file,
        lineAt(text, match.index),
        "domain/socket/db service tags must import from their owning barrel, not #core",
      );
    }
  }
}

function assertExportMap(pkgPath, expected) {
  const file = path.join(repo, pkgPath, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const actual = Object.keys(pkg.exports ?? {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(
      `${pkgPath}/package.json: exports changed; expected ${wanted.join(", ")}, got ${actual.join(", ")}`,
    );
  }
}

const sourceFiles = [];
walk(path.join(repo, "packages"), sourceFiles);
for (const file of sourceFiles) checkSourceFile(file);

// v2 clean slate: nothing under v2/ may import v1 code (workspace packages
// or reach-ins to packages/). The v2 track builds against its own spec.
const v2Files = [];
walk(path.join(repo, "v2"), v2Files);
for (const file of v2Files) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(
    /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']((?:@moltzap\/|(?:\.\.\/)+packages\/)[^"']*)["']/g,
  )) {
    fail(
      file,
      lineAt(text, match.index),
      `v2/ must not import v1 code (${match[1]})`,
    );
  }
}

assertExportMap("packages/protocol", [
  ".",
  "./conversation",
  "./identity",
  "./message",
  "./message/dispatch",
  "./network",
  "./rpc",
  "./socket",
  "./socket/catalog",
  "./task",
  "./testing",
]);
assertExportMap("packages/server", [".", "./test-utils"]);

if (failures.length > 0) {
  console.error("[check-architecture-boundaries] FAIL");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `[check-architecture-boundaries] OK — ${sourceFiles.length + v2Files.length} source files scanned`,
);
