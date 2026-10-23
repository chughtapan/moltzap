/** @file Identity primitives stay independent of request authentication and Registry execution. */

import { readFileSync } from "node:fs";
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
    const forbidden = imports
      .map((entry) => new URL(entry.fileName, source).pathname)
      .filter((file) =>
        /\/(?:authenticated-http|http-signature|signed-message|registry[^/]*)(?:\.[jt]s|\/)/u.test(
          file,
        ),
      );

    expect(forbidden).toStrictEqual([]);
  },
);
