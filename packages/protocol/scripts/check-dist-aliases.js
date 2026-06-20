import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const distRoot = new URL("../dist", import.meta.url).pathname;
const importAliasPattern =
  /\bfrom\s+["']#[^"']+["']|\bimport\s+["']#[^"']+["']/;

function* emittedFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* emittedFiles(path);
      continue;
    }
    if (path.endsWith(".js") || path.endsWith(".d.ts")) {
      yield path;
    }
  }
}

const leaked = [];
for (const file of emittedFiles(distRoot)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (importAliasPattern.test(line)) {
      leaked.push({
        file: relative(process.cwd(), file),
        line: index + 1,
        text: line.trim(),
      });
    }
  }
}

if (leaked.length > 0) {
  console.error("Protocol dist contains unreplaced package-import aliases:");
  for (const item of leaked) {
    console.error(`${item.file}:${item.line}: ${item.text}`);
  }
  process.exit(1);
}
