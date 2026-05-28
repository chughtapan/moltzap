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
 *     `packages/server/src/identity/handlers/connect.handlers.ts`.
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
import {
  collectNumericProperties,
  readTopLevelStringConst,
  type ReadResult,
} from "./generate-cli-docs.helpers.js";

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

const HELLO_FIELDS: ReadonlySet<string> = new Set([
  "maxMessageBytes",
  "maxPartsPerMessage",
  "maxTextLength",
  "maxGroupParticipants",
  "heartbeatIntervalMs",
  "messagesPerMinute",
  "requestsPerMinute",
]);

/**
 * Read the integer literals out of `buildHelloOk` via the TS compiler
 * API. Doctrine-aligned: the AST is the contract, not a regex over the
 * source. A missing field produces a typed failure (no raw throw); the
 * `main` function surfaces it and exits non-zero with a clear message.
 */
const readHelloPolicy = (): ReadResult<HelloPolicy> => {
  const sourcePath = resolve(
    workspaceRoot,
    "packages/server/src/identity/handlers/connect.handlers.ts",
  );
  const found = collectNumericProperties(
    readFileSync(sourcePath, "utf8"),
    HELLO_FIELDS,
  );
  const missing = [...HELLO_FIELDS].filter((k) => !(k in found));
  if (missing.length > 0) {
    return {
      _tag: "err",
      reason: `generate-cli-docs: missing HelloOk policy fields in ${sourcePath}: ${missing.join(", ")}`,
    };
  }
  return {
    _tag: "ok",
    value: {
      maxMessageBytes: found.maxMessageBytes ?? 0,
      maxPartsPerMessage: found.maxPartsPerMessage ?? 0,
      maxTextLength: found.maxTextLength ?? 0,
      maxGroupParticipants: found.maxGroupParticipants ?? 0,
      heartbeatIntervalMs: found.heartbeatIntervalMs ?? 0,
      rateLimits: {
        messagesPerMinute: found.messagesPerMinute ?? 0,
        requestsPerMinute: found.requestsPerMinute ?? 0,
      },
    },
  };
};

/**
 * Read `PROTOCOL_VERSION` from `packages/protocol/src/version.ts` so
 * the generated WS-connect example never drifts from the protocol
 * package. Same AST-first pattern as `readHelloPolicy`.
 */
const readProtocolVersion = (): ReadResult<string> => {
  const sourcePath = resolve(workspaceRoot, "packages/protocol/src/version.ts");
  const result = readTopLevelStringConst(
    readFileSync(sourcePath, "utf8"),
    "PROTOCOL_VERSION",
  );
  if (result._tag === "err") {
    return {
      _tag: "err",
      reason: `generate-cli-docs: ${result.reason} in ${sourcePath}`,
    };
  }
  return result;
};

/**
 * Read `API_KEY_PREFIX` from
 * `packages/server/src/identity/services/agent-auth.ts`. The
 * generated `ws-connect-example.mdx` uses the live prefix instead of
 * a hardcoded `"moltzap_agent_"` so the snippet survives any future
 * prefix change (and the `check-no-hardcoded-constants` API_KEY_PREFIX
 * rule no longer needs `ws-connect-example.mdx` on its allowlist).
 */
const readApiKeyPrefix = (): ReadResult<string> => {
  const sourcePath = resolve(
    workspaceRoot,
    "packages/server/src/identity/services/agent-auth.ts",
  );
  const result = readTopLevelStringConst(
    readFileSync(sourcePath, "utf8"),
    "API_KEY_PREFIX",
  );
  if (result._tag === "err") {
    return {
      _tag: "err",
      reason: `generate-cli-docs: ${result.reason} in ${sourcePath}`,
    };
  }
  return result;
};

interface SnippetInputs {
  readonly policy: HelloPolicy;
  readonly protocolVersion: string;
  readonly apiKeyPrefix: string;
}

const renderHelloPolicySnippet = ({
  policy,
  protocolVersion,
  apiKeyPrefix,
}: SnippetInputs): string => {
  const json = JSON.stringify(
    {
      jsonrpc: "2.0",
      id: "1",
      result: {
        agentId: "550e8400-e29b-41d4-a716-446655440000",
        protocolVersion,
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
        agentKey: `${apiKeyPrefix}abc123...`,
        minProtocol: protocolVersion,
        maxProtocol: protocolVersion,
      },
    },
    null,
    2,
  );
  // Marker exempts the file from the constants gate for these
  // generator-managed literals. Numeric HELLO_* policy values + the
  // `apiKeyPrefix` + `protocolVersion` strings appear inside fenced
  // JSON, where MDX cannot evaluate JSX — baked-at-generation is the
  // robust path. Drift gate catches via git-diff after regen.
  return [
    AUTO_GEN_NOTE,
    "{/* @bake-constants: API_KEY_PREFIX PROTOCOL_VERSION HELLO_MAX_MESSAGE_BYTES HELLO_MAX_PARTS_PER_MESSAGE HELLO_MAX_TEXT_LENGTH HELLO_MAX_GROUP_PARTICIPANTS HELLO_HEARTBEAT_INTERVAL_MS HELLO_MESSAGES_PER_MINUTE HELLO_REQUESTS_PER_MINUTE */}",
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
  const protocolVersion = readProtocolVersion();
  const apiKeyPrefix = readApiKeyPrefix();
  if (policy._tag === "err") {
    console.error(policy.reason);
    process.exit(1);
  }
  if (protocolVersion._tag === "err") {
    console.error(protocolVersion.reason);
    process.exit(1);
  }
  if (apiKeyPrefix._tag === "err") {
    console.error(apiKeyPrefix.reason);
    process.exit(1);
  }
  writeFileSync(
    resolve(snippetsDir, "ws-connect-example.mdx"),
    renderHelloPolicySnippet({
      policy: policy.value,
      protocolVersion: protocolVersion.value,
      apiKeyPrefix: apiKeyPrefix.value,
    }),
  );

  console.log(
    `[generate-cli-docs] wrote reference + ${commands.length} commands + HelloOk snippet (PROTOCOL_VERSION=${protocolVersion.value})`,
  );
};

main();
