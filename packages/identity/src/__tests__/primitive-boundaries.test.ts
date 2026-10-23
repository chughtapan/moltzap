/** @file Identity primitives stay independent of request authentication and Registry execution. */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it.each(["identifiers", "agent-key", "agent-card"])(
  "%s imports only lower identity capabilities",
  (name) => {
    const source = new URL(`../${name}.ts`, import.meta.url);
    const imports = ts.preProcessFile(
      readFileSync(source, "utf8"),
      true,
      true,
    ).importedFiles;
    expect(imports.length).toBeGreaterThan(0);
    const localModules = new Set([
      "agent-key.js",
      "bounded-cache.js",
      "canonical-json.js",
      "identifiers.js",
      "version.js",
      "wire-profile.js",
      "wire-versions.js",
    ]);
    const forbidden = imports
      .map((entry) => entry.fileName)
      .filter((specifier) => {
        if (/^@moltzap\/identity(?:\/|$)/u.test(specifier)) {
          return true;
        }
        if (!specifier.startsWith(".")) {
          return false;
        }
        const file = relative(
          fileURLToPath(new URL("../", import.meta.url)),
          fileURLToPath(new URL(specifier, source)),
        );
        return !localModules.has(file);
      });

    expect(forbidden).toStrictEqual([]);
  },
);
