/**
 * Pre-refactor golden-fixture capture script.
 *
 * Writes literal output strings of the PRE-channel-base formatter logic into
 * `packages/client/src/__tests__/channel-base/fixtures/`. The committed
 * fixture files are immutable artifacts of what the pre-refactor outputs
 * WERE — see arch sub-issue #605 §3.5.
 *
 * SCOPE NOTE — non-empty inputs are pre-refactor byte-equal; the
 * `cross-conv-empty` case pins the post-refactor unified null-return
 * behavior instead of the legacy nanoclaw `<messages></messages>` output.
 * Justification: nanoclaw's pre-refactor `contentFor` already gated on
 * `enriched.contextBlocks.crossConversationMessages?.length > 0` before
 * invoking the formatter, so the formatter was never called with empty
 * input at the channel boundary. Channel-base unifies the empty-check on
 * openclaw's null-return semantic; the channel-base post-refactor
 * `contentFor` retains the equivalent `if (crossConv !== null)` guard,
 * preserving external behavior. Same applies to `group-absent`: the
 * post-refactor flow gates on `getGroupFields(meta) === null` (P3 #609)
 * so no block is emitted, and the fixture pins that decision.
 *
 * The script does NOT import from `@moltzap/openclaw-channel` or
 * `@moltzap/nanoclaw-channel`. Instead, it inlines the pre-refactor formatter
 * logic verbatim from:
 *   - `packages/openclaw-channel/src/format-cross-conv.ts → formatCrossConvOpenClaw`
 *   - `packages/nanoclaw-channel/src/channels/moltzap.ts → formatCrossConvNanoclaw`
 *   - `packages/nanoclaw-channel/src/channels/moltzap.ts → formatGroupBlock`
 *
 * Inlining avoids dep-graph inversion (`@moltzap/client` cannot depend on
 * downstream channel packages) and avoids transient temp-export churn on the
 * source files that are deleted by the same PR. The fixture byte-strings are
 * identical to what the old functions produced; the snapshot tests under
 * `packages/client/src/__tests__/channel-base/` assert byte-equality between
 * these fixtures and the channel-base `formatCrossConv` / `formatGroupBlock`
 * outputs.
 *
 * Usage (run from workspace root, BEFORE any formatter logic moves):
 *
 *   pnpm tsx scripts/capture-channel-base-fixtures.ts
 *
 * The script is checked in so future archaeologists can re-run it (the
 * inlined logic is the canonical record of "what was here"). It is NOT a
 * vitest test and NOT wired into CI.
 *
 * Enumerated edge cases (per spec C #597 AC):
 *   - format-cross-conv: empty, single, multi, own-agent, sender-lookup-none
 *     × { json-header, xml-system-reminder }
 *   - format-group-block: absent, present-name-only, present-with-members
 *     × { json-header, xml-system-reminder }
 *
 * Total: 16 fixture files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Inlined to keep the script dep-free (workspace-root scripts have no
// node_modules linkage to workspace packages without extra plumbing). The
// shapes mirror the public types from `@moltzap/client`:
//   - `CrossConvMessage` (packages/client/src/service.ts)
//   - `EnrichedConversationMeta` (packages/client/src/channel-core.ts)
//   - `sanitizeForSystemReminder` (packages/client/src/service.ts)
//
// Channel-base re-exports the canonical types via the subpath; this script's
// local copies exist only so the fixture-capture step does not require
// building or linking @moltzap/client.

interface CrossConvMessage {
  readonly conversationId: string;
  readonly conversationName?: string;
  readonly senderName: string;
  readonly senderId: string;
  readonly text: string;
  readonly timestamp: string;
}

interface EnrichedConversationMeta {
  readonly type: "dm" | "group";
  readonly name?: string;
  readonly participants: readonly string[];
}

function sanitizeForSystemReminder(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Inlined pre-refactor formatters (verbatim from the named source symbols).
// ---------------------------------------------------------------------------

const CROSS_CONV_HEADER_LEGACY = "Messages (untrusted metadata):";
const JSON_INDENT_SPACES_LEGACY = 2;

// VERBATIM from packages/openclaw-channel/src/format-cross-conv.ts →
// formatCrossConvOpenClaw at HEAD `architect/597-channel-base`.
function legacyFormatCrossConvOpenClaw(
  messages: readonly CrossConvMessage[],
  opts: { ownAgentId: string },
): string | null {
  if (messages.length === 0) return null;
  const items = messages.map((m) => ({
    conversation: m.conversationName ?? `DM with @${m.senderName}`,
    sender: m.senderId === opts.ownAgentId ? "You" : m.senderName,
    text: m.text,
    timestamp: m.timestamp,
  }));
  return `${CROSS_CONV_HEADER_LEGACY}\n\`\`\`json\n${JSON.stringify(items, null, JSON_INDENT_SPACES_LEGACY)}\n\`\`\``;
}

// VERBATIM from packages/nanoclaw-channel/src/channels/moltzap.ts →
// formatCrossConvNanoclaw at HEAD `architect/597-channel-base`.
function legacyFormatCrossConvNanoclaw(
  messages: readonly CrossConvMessage[],
  opts: { ownAgentId: string },
): string {
  const lines = messages.map((m) => {
    const sender = sanitizeForSystemReminder(
      m.senderId === opts.ownAgentId ? "You" : m.senderName,
    );
    const conv = sanitizeForSystemReminder(
      m.conversationName ?? `DM with @${m.senderName}`,
    );
    const text = sanitizeForSystemReminder(m.text);
    const time = sanitizeForSystemReminder(m.timestamp);
    return `<message sender="${sender}" conversation="${conv}" time="${time}">${text}</message>`;
  });
  return ["<messages>", ...lines, "</messages>"].join("\n");
}

// VERBATIM from packages/nanoclaw-channel/src/channels/moltzap.ts →
// formatGroupBlock at HEAD `architect/597-channel-base`.
function legacyFormatGroupBlockNanoclaw(
  meta: EnrichedConversationMeta,
): string {
  const safeName = sanitizeForSystemReminder(meta.name ?? "(unnamed)");
  const safeParticipants = meta.participants.map(sanitizeForSystemReminder);
  return [
    "<system-reminder>",
    "This is a group conversation.",
    `Group name: ${safeName}`,
    `Participants (${meta.participants.length}): ${safeParticipants.join(", ") || "(none listed)"}`,
    "</system-reminder>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fixture cases
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(
  HERE,
  "..",
  "packages",
  "client",
  "src",
  "__tests__",
  "channel-base",
  "fixtures",
);

const OWN_AGENT_ID = "agent-self";
const PEER_NAME = "Bob";
const PEER_ID = "agent-bob";
const ALICE_NAME = "Alice";
const ALICE_ID = "agent-alice";
const GROUP_NAME = "Werewolf Den";
const GROUP_CONV_ID = "conv-1";
const SOLO_CONV_ID = "conv-2";
const TS_1 = "2026-04-13T22:28:00Z";
const TS_2 = "2026-04-13T22:28:05Z";
const TS_3 = "2026-04-13T22:28:10Z";

function bobMessage(): CrossConvMessage {
  return {
    conversationId: GROUP_CONV_ID,
    conversationName: GROUP_NAME,
    senderName: PEER_NAME,
    senderId: PEER_ID,
    text: "Let's target Alice.",
    timestamp: TS_1,
  };
}

function aliceMessage(): CrossConvMessage {
  return {
    conversationId: GROUP_CONV_ID,
    conversationName: GROUP_NAME,
    senderName: ALICE_NAME,
    senderId: ALICE_ID,
    text: "I object.",
    timestamp: TS_2,
  };
}

function selfMessage(): CrossConvMessage {
  return {
    conversationId: SOLO_CONV_ID,
    senderName: "self-agent",
    senderId: OWN_AGENT_ID,
    text: "Acknowledged.",
    timestamp: TS_3,
  };
}

// "Sender lookup returned none" — the upstream resolver fell back to the
// sender id as the display name, AND conversationName is absent so the
// formatter exercises the "DM with @<id>" fallback.
function senderLookupNoneMessage(): CrossConvMessage {
  return {
    conversationId: SOLO_CONV_ID,
    senderName: PEER_ID,
    senderId: PEER_ID,
    text: "Unknown sender path.",
    timestamp: TS_1,
  };
}

function groupMetaPresentWithMembers(): EnrichedConversationMeta {
  return {
    type: "group",
    name: GROUP_NAME,
    participants: [PEER_ID, ALICE_ID, OWN_AGENT_ID],
  };
}

function groupMetaPresentNameOnly(): EnrichedConversationMeta {
  return {
    type: "group",
    name: GROUP_NAME,
    participants: [],
  };
}

interface CrossConvCase {
  readonly name: string;
  readonly messages: readonly CrossConvMessage[];
}

interface GroupCase {
  readonly name: string;
  readonly meta: EnrichedConversationMeta | undefined;
}

const CROSS_CONV_CASES: readonly CrossConvCase[] = [
  { name: "empty", messages: [] },
  { name: "single", messages: [bobMessage()] },
  { name: "multi", messages: [bobMessage(), aliceMessage()] },
  { name: "own-agent", messages: [bobMessage(), selfMessage()] },
  { name: "sender-lookup-none", messages: [senderLookupNoneMessage()] },
];

const GROUP_CASES: readonly GroupCase[] = [
  { name: "absent", meta: undefined },
  { name: "present-name-only", meta: groupMetaPresentNameOnly() },
  { name: "present-with-members", meta: groupMetaPresentWithMembers() },
];

function ensureFixturesDir(): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
}

function writeFixture(relPath: string, contents: string): void {
  const abs = resolve(FIXTURES_DIR, relPath);
  writeFileSync(abs, contents, "utf8");
  console.log(`wrote ${relPath} (${contents.length} bytes)`);
}

// Empty-case framing (resolves P3 #609):
//
//   getGroupFields(meta) === null  →  no formatGroupBlock invocation
//
// The 'absent' case fixture stores the literal sentinel "null\n". The
// channel-base snapshot test asserts that, given a non-group meta,
// `getGroupFields(meta)` is `null` AND no group block is emitted. The
// fixture file is the canonical "no block emitted" pin.
//
// Empty cross-conv input also resolves to `null` (matches the openclaw
// pre-refactor return; channel-base unifies the empty-check). Fixture
// stores the literal sentinel "null\n".
const NULL_SENTINEL = "null\n";

function captureCrossConv(): void {
  for (const c of CROSS_CONV_CASES) {
    // json-header (openclaw pre-refactor)
    const jsonOut = legacyFormatCrossConvOpenClaw(c.messages, {
      ownAgentId: OWN_AGENT_ID,
    });
    writeFixture(
      `format-cross-conv-${c.name}.json-header.md`,
      jsonOut === null ? NULL_SENTINEL : `${jsonOut}\n`,
    );
    // xml-system-reminder (nanoclaw pre-refactor): nanoclaw HEAD returns
    // "<messages>\n</messages>" for empty input; channel-base unifies on
    // openclaw's empty-check semantic (`null` for empty), so the empty
    // fixture pins the post-refactor unified behavior. Non-empty fixtures
    // capture nanoclaw HEAD verbatim.
    if (c.messages.length === 0) {
      writeFixture(
        `format-cross-conv-${c.name}.xml-system-reminder.md`,
        NULL_SENTINEL,
      );
    } else {
      const xmlOut = legacyFormatCrossConvNanoclaw(c.messages, {
        ownAgentId: OWN_AGENT_ID,
      });
      writeFixture(
        `format-cross-conv-${c.name}.xml-system-reminder.md`,
        `${xmlOut}\n`,
      );
    }
  }
}

function captureGroupBlock(): void {
  for (const c of GROUP_CASES) {
    if (c.meta === undefined || c.meta.type !== "group") {
      // getGroupFields(meta) === null path (P3 #609 framing).
      writeFixture(
        `format-group-block-${c.name}.json-header.md`,
        NULL_SENTINEL,
      );
      writeFixture(
        `format-group-block-${c.name}.xml-system-reminder.md`,
        NULL_SENTINEL,
      );
      continue;
    }
    // json-header: openclaw renders no group block. Channel-base returns
    // the empty string; the fixture is a one-byte "\n" to make the file
    // existence assertion explicit.
    writeFixture(`format-group-block-${c.name}.json-header.md`, "\n");
    // xml-system-reminder: nanoclaw HEAD verbatim.
    const xmlOut = legacyFormatGroupBlockNanoclaw(c.meta);
    writeFixture(
      `format-group-block-${c.name}.xml-system-reminder.md`,
      `${xmlOut}\n`,
    );
  }
}

ensureFixturesDir();
captureCrossConv();
captureGroupBlock();
console.log(`\ndone — fixtures written under ${FIXTURES_DIR}`);
