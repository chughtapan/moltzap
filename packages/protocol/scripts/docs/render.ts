import { String as StringOps } from "effect";
import type { RpcErrorTag, RpcJsDoc } from "./rpc-jsdoc.js";
import { extractProperties } from "./schema.js";
import type {
  AnyRpcDocDefinition,
  NotificationDocDefinition,
  SchemaPropertyDoc,
} from "./types.js";

function firstSentence(text: string): string {
  const trimmed = StringOps.replace(/\s+/g, " ")(StringOps.trim(text));
  const m = /^(.+?[.!?])(\s|$)/.exec(trimmed);
  return m?.[1] === undefined ? trimmed : StringOps.trim(m[1]);
}

/**
 * Executes the slugify operation.
 * @param method Wire method name.
 * @returns The slugify result.
 */
export function slugify(method: string): string {
  const withoutSlashes = StringOps.replace(/\//g, "-")(method);
  const separatedWords = StringOps.replace(
    /([a-z0-9])([A-Z])/g,
    "$1-$2",
  )(withoutSlashes);
  return StringOps.toLowerCase(separatedWords);
}

function escapeFrontmatter(s: string): string {
  return StringOps.replace(/"/g, '\\"')(s);
}

function renderMethodHeader(
  method: string,
  description: string,
  body: string,
): string {
  return `---
title: "${method}"
description: "${escapeFrontmatter(description)}"
---

# ${method}

${body}

`;
}

function renderParametersSection(params: readonly SchemaPropertyDoc[]): string {
  if (params.length === 0) {
    return `## Parameters\n\nThis method takes no parameters.\n\n`;
  }

  return (
    `## Parameters\n\n` +
    params
      .map((p) => {
        const req = p.required ? " required" : "";
        const desc = p.description ?? `The ${p.name} field.`;
        const body = desc === "" ? "" : `  ${desc}`;
        return `<ParamField path="${p.name}" type="${p.type}"${req}>\n${body}\n</ParamField>\n\n`;
      })
      .join("")
  );
}

function renderResponseSection(
  result: readonly SchemaPropertyDoc[],
  resultDescription?: string | null,
): string {
  if (result.length === 0) {
    return `## Response\n\nThis method returns an empty object.\n\n`;
  }

  const description = resultDescription ? `${resultDescription}\n\n` : "";
  return (
    `## Response\n\n${description}` +
    result
      .map((r) => {
        const desc = r.description ?? `The ${r.name} field.`;
        const body = desc === "" ? "" : `  ${desc}`;
        return `<ResponseField name="${r.name}" type="${r.type}">\n${body}\n</ResponseField>\n\n`;
      })
      .join("")
  );
}

function renderErrorsSection(errors?: readonly RpcErrorTag[]): string {
  if (!errors || errors.length === 0) {
    return "";
  }
  const rows = errors.map((e) => `| \`${e.name}\` | ${e.when} |\n`);
  return `## Errors\n\n| Type | When |\n|------|------|\n${rows.join("")}\n`;
}

function renderRelatedNotificationsSection(
  notifications?: readonly string[],
): string {
  if (!notifications || notifications.length === 0) {
    return "";
  }

  const links = notifications.map(
    (notification) =>
      `- [\`${notification}\`](/protocol/notifications/${slugify(notification)})\n`,
  );
  return `## Related Notifications\n\n${links.join("")}\n`;
}

/**
 * Executes the generate method page operation.
 * @param def Definition to process.
 * @param jsdoc Value supplied to the operation.
 * @returns The generate method page result.
 */
export function generateMethodPage(
  def: AnyRpcDocDefinition,
  jsdoc?: RpcJsDoc,
): string {
  const method = def.name;
  const description = jsdoc?.description ?? `Call \`${method}\`.`;
  const subtitle = firstSentence(description);
  const body = jsdoc?.body ? `${description}\n\n${jsdoc.body}` : description;
  return [
    renderMethodHeader(method, subtitle, body),
    renderParametersSection(extractProperties(def.paramsSchema)),
    renderResponseSection(
      extractProperties(def.resultSchema),
      jsdoc?.resultDescription,
    ),
    renderErrorsSection(jsdoc?.errors),
    renderRelatedNotificationsSection(jsdoc?.relatedNotifications),
  ].join("");
}

/**
 * Executes the generate notification page operation.
 * @param def Definition to process.
 * @param jsdoc Value supplied to the operation.
 * @returns The generate notification page result.
 */
export function generateNotificationPage(
  def: NotificationDocDefinition,
  jsdoc?: RpcJsDoc,
): string {
  const fields = extractProperties(def.paramsSchema);
  const name = def.name;
  const description =
    jsdoc?.description ?? `Pushed as the \`${name}\` notification.`;
  const subtitle = firstSentence(description);

  let mdx = `---
title: "${name}"
description: "${escapeFrontmatter(subtitle)}"
---

# ${name}

${description}

## Params

`;

  for (const f of fields) {
    const desc = f.description || `The ${f.name} field.`;
    mdx += `<ResponseField name="${f.name}" type="${f.type}">\n  ${desc}\n</ResponseField>\n\n`;
  }

  // Example
  mdx += `## Example\n\n\`\`\`json\n{\n  "jsonrpc": "2.0",\n  "method": "${name}",\n  "params": { ... }\n}\n\`\`\`\n\n`;

  // Triggered by
  if (jsdoc?.triggeredBy && jsdoc.triggeredBy.length > 0) {
    mdx += `## Triggered By\n\n`;
    for (const m of jsdoc.triggeredBy) {
      mdx += `- [\`${m}\`](/protocol/methods/${slugify(m)})\n`;
    }
    mdx += `\n`;
  }

  return mdx;
}
