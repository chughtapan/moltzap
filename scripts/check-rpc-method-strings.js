const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const repo = process.cwd();
const methodsDirs = [
  path.join(repo, "packages", "protocol", "src", "network", "methods"),
  path.join(repo, "packages", "protocol", "src", "task", "methods"),
  path.join(repo, "packages", "protocol", "src", "app", "methods"),
];

const methodByName = new Map();
for (const methodsDir of methodsDirs) {
  if (!fs.existsSync(methodsDir)) continue;
  for (const entry of fs.readdirSync(methodsDir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const file = path.join(methodsDir, entry);
    const text = fs.readFileSync(file, "utf8");
    const pattern =
      /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*defineRpc\(\s*\{[\s\S]*?\bname:\s*"([^"]+)"/g;
    for (const match of text.matchAll(pattern)) {
      methodByName.set(match[2], match[1]);
    }
  }
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

const files = [];
walk(path.join(repo, "packages"), files);

function isMethodDefinitionFile(file) {
  return methodsDirs.some((dir) => file.startsWith(dir + path.sep));
}

for (const file of files) {
  if (isMethodDefinitionFile(file)) continue;
  const sourceText = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lineStarts = source.getLineStarts();
  const lines = sourceText.split(/\r?\n/);

  function report(node, methodName) {
    const symbol = methodByName.get(methodName);
    if (!symbol) return;
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    const lineNo = pos.line + 1;
    const colNo = pos.character + 1;
    const rel = path.relative(repo, file);
    const lineText = lines[pos.line]?.trim() ?? "";
    console.log(
      `${rel}:${lineNo}:${colNo}: raw RPC method string ${JSON.stringify(
        methodName,
      )}; use ${symbol}.name :: ${lineText}`,
    );
  }

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text);
    }
    ts.forEachChild(node, visit);
  }

  void lineStarts;
  visit(source);
}
