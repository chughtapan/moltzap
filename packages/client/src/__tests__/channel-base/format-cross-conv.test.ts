/**
 * Golden-snapshot tests for `formatCrossConv`.
 *
 * Each case asserts byte-equality between the channel-base output and the
 * fixture captured by `scripts/capture-channel-base-fixtures.ts`. Both markup
 * variants are covered, plus the formatter-callback escape hatch.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CrossConvFormatter,
  type CrossConvMarkup,
  formatCrossConv,
} from "../../channel-base/format-cross-conv.js";
import type { CrossConvMessage } from "../../service.js";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
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
const NULL_SENTINEL = "null\n";
const CUSTOM_FORMATTER_OUTPUT = "custom-formatter-output";
const MARKUPS: readonly CrossConvMarkup[] = [
  "json-header",
  "xml-system-reminder",
];

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

function senderLookupNoneMessage(): CrossConvMessage {
  return {
    conversationId: SOLO_CONV_ID,
    senderName: PEER_ID,
    senderId: PEER_ID,
    text: "Unknown sender path.",
    timestamp: TS_1,
  };
}

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly messages: readonly CrossConvMessage[];
}> = [
  { name: "empty", messages: [] },
  { name: "single", messages: [bobMessage()] },
  { name: "multi", messages: [bobMessage(), aliceMessage()] },
  { name: "own-agent", messages: [bobMessage(), selfMessage()] },
  { name: "sender-lookup-none", messages: [senderLookupNoneMessage()] },
];

function fixtureFor(caseName: string, markup: CrossConvMarkup): string {
  return readFileSync(
    resolve(FIXTURES_DIR, `format-cross-conv-${caseName}.${markup}.md`),
    "utf8",
  );
}

describe("formatCrossConv — markup variants byte-identical to pre-refactor", () => {
  it(
    "property: empty input returns null regardless of markup",
    propertyEmptyInputReturnsNull,
  );
  for (const markup of MARKUPS) {
    for (const c of CASES) {
      it(`markup=${markup} case=${c.name}`, () =>
        assertCaseMatchesFixture(c.messages, c.name, markup));
    }
  }
});

describe("formatCrossConv — formatter callback escape hatch", () => {
  it(
    "delegates rendering to the supplied formatter for non-empty input",
    delegatesToFormatter,
  );
  it(
    "returns null for empty input even when a formatter is supplied",
    returnsNullForEmptyEvenWithFormatter,
  );
});

function propertyEmptyInputReturnsNull(): void {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 16 }),
      fc.constantFrom<CrossConvMarkup>(...MARKUPS),
      (ownAgentId, markup) => {
        expect(formatCrossConv([], { ownAgentId, markup })).toBeNull();
      },
    ),
  );
}

function assertCaseMatchesFixture(
  messages: readonly CrossConvMessage[],
  caseName: string,
  markup: CrossConvMarkup,
): void {
  const actual = formatCrossConv(messages, {
    ownAgentId: OWN_AGENT_ID,
    markup,
  });
  const expectedRaw = fixtureFor(caseName, markup);
  if (expectedRaw === NULL_SENTINEL) {
    expect(actual).toBeNull();
  } else {
    // The fixture file has a trailing newline for readability; the
    // formatter return does not.
    expect(`${actual ?? ""}\n`).toBe(expectedRaw);
  }
}

function delegatesToFormatter(): void {
  const seen: {
    messages?: readonly CrossConvMessage[];
    ownAgentId?: string;
  } = {};
  const formatter: CrossConvFormatter = (messages, opts) => {
    seen.messages = messages;
    seen.ownAgentId = opts.ownAgentId;
    return CUSTOM_FORMATTER_OUTPUT;
  };
  const out = formatCrossConv([bobMessage()], {
    ownAgentId: OWN_AGENT_ID,
    formatter,
  });
  expect(out).toBe(CUSTOM_FORMATTER_OUTPUT);
  expect(seen.messages?.length).toBe(1);
  expect(seen.ownAgentId).toBe(OWN_AGENT_ID);
}

function returnsNullForEmptyEvenWithFormatter(): void {
  const formatter: CrossConvFormatter = () => CUSTOM_FORMATTER_OUTPUT;
  expect(
    formatCrossConv([], { ownAgentId: OWN_AGENT_ID, formatter }),
  ).toBeNull();
}
