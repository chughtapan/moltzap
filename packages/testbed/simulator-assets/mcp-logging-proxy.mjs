/**
 * @file MCP logging proxy: fronts one consumer stdio MCP server. Bytes
 * relay unchanged in both directions (interface transparency: results
 * are byte-identical with and without the proxy); a parsed COPY of each
 * newline-delimited JSON-RPC frame reports `tools/call` requests and
 * their responses to the simulator over a local TCP tap. A tap that dies
 * mid-run ends the proxy: capture is total, so an uncaptured mount is a
 * logging-proxy failure, never a silent gap.
 */
import net from "node:net";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new Error("missing -- separator");
  const options = new Map();
  for (let index = 0; index < separator; index += 2) {
    options.set(argv[index], argv[index + 1]);
  }
  const command = argv[separator + 1];
  if (command === undefined) throw new Error("missing proxied command");
  return {
    tapPort: Number(options.get("--tap")),
    mount: options.get("--mount") ?? "",
    command,
    args: argv.slice(separator + 2),
  };
}

function lineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  const pendingToolCalls = new Map();
  const tap = net.connect({ host: "127.0.0.1", port: config.tapPort });
  const report = (payload) => {
    tap.write(`${JSON.stringify({ ...payload, mount: config.mount })}\n`);
  };
  tap.on("error", () => process.exit(1));
  tap.on("close", () => process.exit(1));

  const child = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.on("error", (cause) => {
    report({ type: "fatal", message: `spawn failed: ${String(cause)}` });
    process.exit(1);
  });
  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });

  // Raw relay first; the tap parses copies and never rewrites bytes.
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);

  process.stdin.on(
    "data",
    lineSplitter((line) => {
      const frame = tryParse(line);
      if (frame === undefined) return;
      if (frame.method === "tools/call" && frame.id !== undefined) {
        const tool =
          frame.params && typeof frame.params.name === "string"
            ? frame.params.name
            : "";
        pendingToolCalls.set(frame.id, tool);
        report({
          type: "call",
          id: frame.id,
          tool,
          args: frame.params?.arguments ?? null,
        });
      }
    }),
  );
  child.stdout.on(
    "data",
    lineSplitter((line) => {
      const frame = tryParse(line);
      if (frame === undefined || frame.id === undefined) return;
      const tool = pendingToolCalls.get(frame.id);
      if (tool === undefined) return;
      pendingToolCalls.delete(frame.id);
      report({
        type: "result",
        id: frame.id,
        tool,
        result: frame.error ?? frame.result ?? null,
        isError:
          frame.error !== undefined ||
          (frame.result !== null &&
            typeof frame.result === "object" &&
            frame.result.isError === true),
      });
    }),
  );
}

function tryParse(line) {
  try {
    const value = JSON.parse(line);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

main();
