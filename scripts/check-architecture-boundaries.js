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

// The v2 boundary law — package set, version, exports, binaries, the
// dependency DAG, and the v1/v2 import rules — lives in
// scripts/check-v2-boundaries.js, which resolves package names against the
// real workspace layout instead of matching the shared @moltzap/ scope.

assertExportMap("packages/protocol", [
  ".",
  "./bounded-map",
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
  `[check-architecture-boundaries] OK — ${sourceFiles.length} source files scanned`,
);
