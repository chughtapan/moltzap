import type { RpcErrorTag, RpcJsDoc } from "./rpc-jsdoc.js";
import { extractProperties, type SchemaPropertyDoc } from "./schema.js";
import type {
  AnyRpcDocDefinition,
  NotificationDocDefinition,
} from "./types.js";

export function slugify(method: string): string {
  return method
    .replace(/\//g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function generateMethodPage(
  def: AnyRpcDocDefinition,
  jsdoc: RpcJsDoc | undefined,
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
      jsdoc?.resultDescription ?? null,
    ),
    renderErrorsSection(jsdoc?.errors),
    renderRelatedNotificationsSection(jsdoc?.relatedNotifications),
  ].join("");
}

export function generateNotificationPage(
  def: NotificationDocDefinition,
  jsdoc: RpcJsDoc | undefined,
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

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const m = trimmed.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1]!.trim() : trimmed;
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
  if (params.length === 0)
    return `## Parameters\n\nThis method takes no parameters.\n\n`;

  return (
    `## Parameters\n\n` +
    params
      .map((p) => {
        const req = p.required ? " required" : "";
        const desc = p.description || `The ${p.name} field.`;
        return `<ParamField path="${p.name}" type="${p.type}"${req}>\n  ${desc}\n</ParamField>\n\n`;
      })
      .join("")
  );
}

function renderResponseSection(
  result: readonly SchemaPropertyDoc[],
  resultDescription: string | undefined,
): string {
  if (result.length === 0)
    return `## Response\n\nThis method returns an empty object.\n\n`;

  const description = resultDescription ? `${resultDescription}\n\n` : "";
  return (
    `## Response\n\n${description}` +
    result
      .map((r) => {
        const desc = r.description || `The ${r.name} field.`;
        return `<ResponseField name="${r.name}" type="${r.type}">\n  ${desc}\n</ResponseField>\n\n`;
      })
      .join("")
  );
}

function renderErrorsSection(
  errors: readonly RpcErrorTag[] | undefined,
): string {
  if (!errors || errors.length === 0) return "";
  const rows = errors.map((e) => `| \`${e.name}\` | ${e.when} |\n`);
  return `## Errors\n\n| Type | When |\n|------|------|\n${rows.join("")}\n`;
}

function renderRelatedNotificationsSection(
  notifications: readonly string[] | undefined,
): string {
  if (!notifications || notifications.length === 0) return "";

  const links = notifications.map(
    (notification) =>
      `- [\`${notification}\`](/protocol/notifications/${slugify(notification)})\n`,
  );
  return `## Related Notifications\n\n${links.join("")}\n`;
}

function escapeFrontmatter(s: string): string {
  return s.replace(/"/g, '\\"');
}
