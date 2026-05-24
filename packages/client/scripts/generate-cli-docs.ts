#!/usr/bin/env tsx
/**
 * @file CLI documentation generator. Captures `moltzap <command> --help`
 * for every command + subcommand and renders it to MDX. The source of
 * truth is the `@effect/cli` `Command` graph in `packages/client/src/cli/`;
 * any change to a `Command`'s flags or signature flows through `--help`
 * straight into the generated docs.
 *
 * Outputs:
 *   - `docs/cli/reference.mdx` — per-command reference page.
 *   - `docs/snippets/cli-commands-table.mdx` — table for `cli/overview.mdx`.
 *   - `docs/snippets/cli-global-flags.mdx` — root-command global flags block.
 *   - `docs/snippets/server-hello-policy.mdx` — HelloOk policy JSON
 *     extracted from `buildHelloOk` in
 *     `packages/server/src/task/handlers/connect.handlers.ts`.
 *
 * Hook into `pnpm docs:generate`; `pnpm docs:check:drift` then catches
 * any drift between the CLI source and these files.
 *
 * Drift-resistance: re-running the script is idempotent (deterministic
 * source data → deterministic MDX). The doc pipeline diffs the working
 * tree after running; non-zero diff fails CI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const clientPkgDir = resolve(scriptDir, "..");
const workspaceRoot = resolve(clientPkgDir, "..", "..");
const docsDir = resolve(workspaceRoot, "docs");
const cliDocsDir = resolve(docsDir, "cli");
const snippetsDir = resolve(docsDir, "snippets");
const cliBin = resolve(clientPkgDir, "dist", "cli", "index.js");

// Built from String.fromCharCode to avoid oxlint's no-control-regex
// warning on a literal \x1B in the source. The ESC byte (0x1B)
// prefixes every ANSI CSI sequence emitted by `@effect/cli --help`.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

interface ArgumentDoc {
  readonly name: string;
  readonly description: string;
}

interface OptionDoc {
  readonly signature: string;
  readonly description: string;
}

interface SubcommandDoc {
  readonly signature: string;
  readonly description: string;
}

interface CommandHelp {
  readonly path: readonly string[];
  readonly usage: string;
  readonly description: string;
  readonly arguments: readonly ArgumentDoc[];
  readonly options: readonly OptionDoc[];
  readonly subcommands: readonly SubcommandDoc[];
}

/**
 * Hand-maintained roster of commands to query. The list mirrors
 * `packages/client/src/cli/index.ts → Command.withSubcommands([...])`
 * plus the subcommand groups that own their own sub-subcommands. A
 * missing entry produces an empty reference section (verifiable via
 * `pnpm docs:check:drift`).
 */
const COMMAND_PATHS: readonly (readonly string[])[] = [
  ["register"],
  ["whoami"],
  ["send"],
  ["contacts"],
  ["contacts", "list"],
  ["contacts", "add"],
  ["contacts", "accept"],
  ["conversations"],
  ["conversations", "history"],
  ["history"],
  ["invite"],
  ["presence"],
  ["ping"],
  ["status"],
  ["agents"],
  ["agents", "list"],
  ["agents", "lookup"],
  ["messages"],
  ["messages", "list"],
  ["start"],
];

const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

/**
 * `@effect/cli`'s `--help` is conventionally formatted with section
 * headers in caps (USAGE, DESCRIPTION, ARGUMENTS, OPTIONS, COMMANDS).
 * We split on those headers so each section parser sees a stable slice.
 */
const SECTION_HEADERS = [
  "USAGE",
  "DESCRIPTION",
  "ARGUMENTS",
  "OPTIONS",
  "COMMANDS",
] as const;

type SectionName = (typeof SECTION_HEADERS)[number];

const splitSections = (raw: string): Map<SectionName, string> => {
  const sections = new Map<SectionName, string>();
  const lines = raw.split("\n");
  let current: SectionName | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) {
      sections.set(current, buf.join("\n").trim());
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const header = SECTION_HEADERS.find((h) => trimmed === h);
    if (header !== undefined) {
      flush();
      current = header;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
};

const captureHelp = (path: readonly string[]): string => {
  const args = [cliBin, ...path, "--help"];
  // FORCE_COLOR=0 disables ANSI; some terminals re-add it via TTY checks
  // so we strip defensively too. `--no-color` is not recognized by Effect
  // CLI, so env-based suppression + post-strip is the reliable path.
  const stdout = execFileSync("node", args, {
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stripAnsi(stdout);
};

/**
 * `@effect/cli` formats one argument as:
 *
 *     <name>
 *
 *       A user-defined piece of text.
 *
 *       <description>
 *
 * Filter out the type-line ("A user-defined piece of text." /
 * "An integer." / "A true or false value." / "One of the following: ...")
 * and keep the human description. Repeated args get `...` appended in
 * USAGE; we keep them as-is.
 */
const TYPE_LINE_RE =
  /^(A user-defined piece of text|An integer|A true or false value|One of the following[^.]*|This argument may be repeated[^.]*)\.$/;

const parseArguments = (sectionText: string): readonly ArgumentDoc[] => {
  if (sectionText === "") return [];
  const blocks = splitOnIndentedHeader(sectionText);
  return blocks
    .map((block) => parseArgumentBlock(block))
    .filter((arg): arg is ArgumentDoc => arg !== null);
};

const splitOnIndentedHeader = (text: string): readonly string[] => {
  // A header line is left-flush (no leading whitespace) and starts a new
  // block. Body lines are indented. Two consecutive blank lines also end
  // a block.
  const lines = text.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  };
  for (const line of lines) {
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
    }
    current.push(line);
  }
  flush();
  return blocks.map((b) => b.join("\n").trim()).filter((b) => b.length > 0);
};

const parseArgumentBlock = (block: string): ArgumentDoc | null => {
  const lines = block.split("\n");
  if (lines.length === 0) return null;
  const header = lines[0]?.trim() ?? "";
  if (header === "") return null;
  const bodyLines = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const descriptionLines = bodyLines.filter((l) => !TYPE_LINE_RE.test(l));
  const description = descriptionLines.join(" ").trim();
  return { name: header, description };
};

const parseOptions = (sectionText: string): readonly OptionDoc[] => {
  if (sectionText === "") return [];
  const blocks = splitOnIndentedHeader(sectionText);
  return blocks
    .map((block) => parseOptionBlock(block))
    .filter((opt): opt is OptionDoc => opt !== null)
    .filter((opt) => !isGlobalCliOption(opt.signature));
};

/**
 * Effect CLI injects the same global options on every command:
 *   --completions, --log-level, (-h, --help), --wizard, --version.
 * The reference page surfaces these once, under "Global flags", not
 * per-command (the rendered output otherwise repeats 5 entries per
 * subcommand, drowning the per-command differences).
 */
const GLOBAL_OPTIONS = new Set([
  "--completions sh | bash | fish | zsh",
  "--log-level all | trace | debug | info | warning | error | fatal | none",
  "(-h, --help)",
  "--wizard",
  "--version",
]);

const isGlobalCliOption = (signature: string): boolean =>
  GLOBAL_OPTIONS.has(signature);

const parseOptionBlock = (block: string): OptionDoc | null => {
  const lines = block.split("\n");
  if (lines.length === 0) return null;
  const signature = lines[0]?.trim() ?? "";
  if (signature === "") return null;
  const bodyLines = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const descriptionLines = bodyLines
    .filter((l) => !TYPE_LINE_RE.test(l))
    .filter((l) => l !== "This setting is optional.");
  const description = descriptionLines.join(" ").trim();
  return { signature, description };
};

/**
 * The COMMANDS section is rendered as `- <signature>  <description>`
 * pairs separated by blank lines. The signature may span the line up
 * to the description's left edge; we split on the first run of >=2
 * spaces.
 */
const parseSubcommands = (sectionText: string): readonly SubcommandDoc[] => {
  if (sectionText === "") return [];
  const subs: SubcommandDoc[] = [];
  const lines = sectionText.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const split = body.match(/^(\S(?:.*?\S)?)\s{2,}(.*)$/);
    if (split === null) {
      subs.push({ signature: body, description: "" });
      continue;
    }
    subs.push({
      signature: (split[1] ?? "").trim(),
      description: (split[2] ?? "").trim(),
    });
  }
  return subs;
};

const parseUsage = (sectionText: string): string => {
  const line = sectionText.split("\n").find((l) => l.trim().startsWith("$"));
  if (line === undefined) return sectionText.trim();
  return line.replace(/^\s*\$\s*/, "").trim();
};

const readHelp = (path: readonly string[]): CommandHelp => {
  const raw = captureHelp(path);
  const sections = splitSections(raw);
  const usageRaw = sections.get("USAGE") ?? "";
  const description = (sections.get("DESCRIPTION") ?? "").trim();
  const argumentsDoc = parseArguments(sections.get("ARGUMENTS") ?? "");
  const optionsDoc = parseOptions(sections.get("OPTIONS") ?? "");
  const subcommandsDoc = parseSubcommands(sections.get("COMMANDS") ?? "");
  return {
    path,
    usage: parseUsage(usageRaw),
    description,
    arguments: argumentsDoc,
    options: optionsDoc,
    subcommands: subcommandsDoc,
  };
};

// ─── MDX renderers ────────────────────────────────────────────────────────

const AUTO_GEN_NOTE =
  "{/* AUTO-GENERATED by packages/client/scripts/generate-cli-docs.ts. " +
  "Do not edit by hand — re-run `pnpm docs:generate`. */}";

const renderCommandReference = (cmd: CommandHelp): string => {
  const cmdLabel = ["moltzap", ...cmd.path].join(" ");
  const heading = `### \`${cmdLabel}\``;
  const usage = `**Usage:** \`moltzap ${cmd.usage}\``;
  const parts: string[] = [heading];
  if (cmd.description !== "") parts.push(cmd.description);
  parts.push(usage);
  if (cmd.arguments.length > 0) {
    parts.push(
      [
        "**Arguments:**",
        "",
        ...cmd.arguments.map(
          (a) =>
            `- \`${a.name}\`${a.description === "" ? "" : ` — ${a.description}`}`,
        ),
      ].join("\n"),
    );
  }
  if (cmd.options.length > 0) {
    parts.push(
      [
        "**Options:**",
        "",
        ...cmd.options.map(
          (o) =>
            `- \`${o.signature}\`${o.description === "" ? "" : ` — ${o.description}`}`,
        ),
      ].join("\n"),
    );
  }
  if (cmd.subcommands.length > 0) {
    parts.push(
      [
        "**Subcommands:**",
        "",
        ...cmd.subcommands.map(
          (s) =>
            `- \`${s.signature}\`${s.description === "" ? "" : ` — ${s.description}`}`,
        ),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
};

const renderReferencePage = (
  rootHelp: CommandHelp,
  commands: readonly CommandHelp[],
): string => {
  const sections = commands.map(renderCommandReference);
  return [
    "---",
    "title: CLI Reference",
    "description: Auto-generated reference for every `moltzap` subcommand",
    "---",
    "",
    AUTO_GEN_NOTE,
    "",
    "# CLI Reference",
    "",
    "Source of truth: the `@effect/cli` `Command` graph in",
    "`packages/client/src/cli/`. This page is regenerated by",
    "`pnpm docs:generate`; drift is caught by `pnpm docs:check:drift`.",
    "",
    "## Synopsis",
    "",
    `\`${rootHelp.usage}\``,
    "",
    rootHelp.description,
    "",
    "## Global flags",
    "",
    "These flags are accepted on every subcommand:",
    "",
    "- `--as <apiKey>` — Dial the server as the agent owning this API key, bypassing the local daemon.",
    "- `--profile <name>` — Load an existing named profile from `~/.moltzap/config.json` for this invocation.",
    "- `--log-level <level>` — Set the minimum log level (`all | trace | debug | info | warning | error | fatal | none`).",
    "- `--completions <shell>` — Generate a completion script (`sh | bash | fish | zsh`).",
    "- `-h, --help` — Show help for a command.",
    "- `--version` — Show the CLI version.",
    "",
    "Precedence: `--as` wins over `--profile`; `--profile` wins over the top-level default profile.",
    "",
    "## Commands",
    "",
    ...sections.flatMap((s) => [s, ""]),
  ].join("\n");
};

const renderCommandsTable = (commands: readonly CommandHelp[]): string => {
  const topLevel = commands.filter((c) => c.path.length === 1);
  const rows = topLevel.map((c) => {
    const desc = (c.description.split(/[.\n]/)[0] ?? "").trim();
    return `| \`${c.path.join(" ")}\` | ${desc} |`;
  });
  return [
    AUTO_GEN_NOTE,
    "",
    "| Command | Description |",
    "|---------|-------------|",
    ...rows,
    "",
  ].join("\n");
};

const renderGlobalFlagsSnippet = (rootHelp: CommandHelp): string =>
  [AUTO_GEN_NOTE, "", rootHelp.description, ""].join("\n");

// ─── HelloOk policy snippet (drift-proof against connect.handlers.ts) ────

interface HelloPolicy {
  readonly maxMessageBytes: number;
  readonly maxPartsPerMessage: number;
  readonly maxTextLength: number;
  readonly maxGroupParticipants: number;
  readonly heartbeatIntervalMs: number;
  readonly rateLimits: {
    readonly messagesPerMinute: number;
    readonly requestsPerMinute: number;
  };
}

/**
 * Read the integer literals out of `buildHelloOk` directly. The function
 * is a `const`-only object literal; a small regex over the source is
 * cheaper than spinning up a TS compiler-API rig for one struct.
 */
const readHelloPolicy = (): HelloPolicy => {
  const sourcePath = resolve(
    workspaceRoot,
    "packages/server/src/task/handlers/connect.handlers.ts",
  );
  const src = readFileSync(sourcePath, "utf8");
  const grabInt = (key: string): number => {
    const m = src.match(new RegExp(`${key}:\\s*(\\d+)`));
    if (m === null || m[1] === undefined) {
      throw new Error(
        `generate-cli-docs: failed to read ${key} from ${sourcePath}`,
      );
    }
    return Number(m[1]);
  };
  return {
    maxMessageBytes: grabInt("maxMessageBytes"),
    maxPartsPerMessage: grabInt("maxPartsPerMessage"),
    maxTextLength: grabInt("maxTextLength"),
    maxGroupParticipants: grabInt("maxGroupParticipants"),
    heartbeatIntervalMs: grabInt("heartbeatIntervalMs"),
    rateLimits: {
      messagesPerMinute: grabInt("messagesPerMinute"),
      requestsPerMinute: grabInt("requestsPerMinute"),
    },
  };
};

const renderHelloPolicySnippet = (policy: HelloPolicy): string => {
  const json = JSON.stringify(
    {
      jsonrpc: "2.0",
      id: "1",
      result: {
        agentId: "550e8400-e29b-41d4-a716-446655440000",
        protocolVersion: "2026.503.4",
        policy,
      },
    },
    null,
    2,
  );
  const request = JSON.stringify(
    {
      jsonrpc: "2.0",
      id: "1",
      method: "network/connect",
      params: {
        agentKey: "moltzap_agent_abc123...",
        minProtocol: "2026.503.4",
        maxProtocol: "2026.503.4",
      },
    },
    null,
    2,
  );
  return [
    AUTO_GEN_NOTE,
    "",
    "<Tabs>",
    '  <Tab title="Request">',
    "    ```json",
    ...request.split("\n").map((l) => `    ${l}`),
    "    ```",
    "  </Tab>",
    '  <Tab title="Response (HelloOk)">',
    "    ```json",
    ...json.split("\n").map((l) => `    ${l}`),
    "    ```",
    "  </Tab>",
    "</Tabs>",
    "",
  ].join("\n");
};

// ─── Entry point ──────────────────────────────────────────────────────────

const main = (): void => {
  mkdirSync(cliDocsDir, { recursive: true });
  mkdirSync(snippetsDir, { recursive: true });

  const rootHelp = readHelp([]);
  const commands = COMMAND_PATHS.map((p) => readHelp(p));

  writeFileSync(
    resolve(cliDocsDir, "reference.mdx"),
    renderReferencePage(rootHelp, commands),
  );
  writeFileSync(
    resolve(snippetsDir, "cli-commands-table.mdx"),
    renderCommandsTable(commands),
  );
  writeFileSync(
    resolve(snippetsDir, "cli-global-flags.mdx"),
    renderGlobalFlagsSnippet(rootHelp),
  );

  const policy = readHelloPolicy();
  writeFileSync(
    resolve(snippetsDir, "ws-connect-example.mdx"),
    renderHelloPolicySnippet(policy),
  );

  console.log(
    `[generate-cli-docs] wrote reference + ${commands.length} commands + HelloOk snippet`,
  );
};

main();
