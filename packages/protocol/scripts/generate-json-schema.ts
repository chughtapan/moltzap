import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import * as schemas from "../src/schema/index.js";

const outDir = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "dist",
  "schemas",
);
mkdirSync(outDir, { recursive: true });

const schemaEntries = Object.entries(schemas).filter(
  ([name, value]) =>
    name.endsWith("Schema") &&
    typeof value === "object" &&
    value !== null &&
    "type" in value,
);

for (const [name, schema] of schemaEntries) {
  const filename = name.replace(/Schema$/, "") + ".json";
  writeFileSync(join(outDir, filename), JSON.stringify(schema, null, 2) + "\n");
}

// eslint-disable-next-line no-console
console.log(`Generated ${schemaEntries.length} JSON Schema files in ${outDir}`);
