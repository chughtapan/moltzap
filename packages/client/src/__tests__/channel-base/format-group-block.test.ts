/**
 * Golden-snapshot tests for `formatGroupBlock` + `getGroupFields`.
 *
 * Resolves P3 #609 framing: the `absent` case asserts
 * `getGroupFields(meta) === null` (the non-null check is the gate).
 * For group meta, both markup variants are asserted byte-identical to the
 * pre-refactor fixtures captured by
 * `scripts/capture-channel-base-fixtures.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatGroupBlock,
  getGroupFields,
  type GroupFormatter,
} from "../../channel-base/format-group-block.js";
import type { CrossConvMarkup } from "../../channel-base/format-cross-conv.js";
import type { EnrichedConversationMeta } from "../../channel-core.js";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const PEER_ID = "agent-bob";
const ALICE_ID = "agent-alice";
const OWN_AGENT_ID = "agent-self";
const GROUP_NAME = "Werewolf Den";
const NULL_SENTINEL = "null\n";
const CUSTOM_FORMATTER_OUTPUT = "custom-group-formatter-output";
const MARKUPS: readonly CrossConvMarkup[] = [
  "json-header",
  "xml-system-reminder",
];

const PRESENT_NAME_ONLY_META: EnrichedConversationMeta = {
  type: "group",
  name: GROUP_NAME,
  participants: [],
};

const PRESENT_WITH_MEMBERS_META: EnrichedConversationMeta = {
  type: "group",
  name: GROUP_NAME,
  participants: [PEER_ID, ALICE_ID, OWN_AGENT_ID],
};

const DM_META: EnrichedConversationMeta = {
  type: "dm",
  participants: [PEER_ID, OWN_AGENT_ID],
};

function fixtureFor(caseName: string, markup: CrossConvMarkup): string {
  return readFileSync(
    resolve(FIXTURES_DIR, `format-group-block-${caseName}.${markup}.md`),
    "utf8",
  );
}

describe("getGroupFields", () => {
  it(
    "property: returns null for any non-group meta, structured fields for group meta",
    propertyMatchesNarrowingPredicate,
  );
  it("returns null when meta is undefined (P3 #609 framing)", undefinedIsNull);
  it("returns null when meta.type !== 'group' (P3 #609 framing)", dmMetaIsNull);
  it(
    "returns { name, participants } for group meta with participants",
    groupWithMembers,
  );
  it(
    "returns { name, participants:[] } for group meta with no participants",
    groupNameOnly,
  );
});

describe("formatGroupBlock — markup variants byte-identical to pre-refactor", () => {
  it(
    "case=absent — getGroupFields returns null (no block emitted), both markups",
    absentCaseFraming,
  );
  for (const markup of MARKUPS) {
    it(`markup=${markup} case=present-name-only`, () =>
      assertPresentMatchesFixture(
        PRESENT_NAME_ONLY_META,
        "present-name-only",
        markup,
      ));
    it(`markup=${markup} case=present-with-members`, () =>
      assertPresentMatchesFixture(
        PRESENT_WITH_MEMBERS_META,
        "present-with-members",
        markup,
      ));
  }
});

describe("formatGroupBlock — formatter callback escape hatch", () => {
  it("delegates rendering to the supplied formatter", delegatesToFormatter);
});

function propertyMatchesNarrowingPredicate(): void {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant<EnrichedConversationMeta | undefined>(undefined),
        fc.constant<EnrichedConversationMeta>(DM_META),
        fc.constant<EnrichedConversationMeta>(PRESENT_NAME_ONLY_META),
        fc.constant<EnrichedConversationMeta>(PRESENT_WITH_MEMBERS_META),
      ),
      assertNarrowingMatchesType,
    ),
  );
}

function assertNarrowingMatchesType(
  meta: EnrichedConversationMeta | undefined,
): void {
  if (meta === undefined) {
    expect(getGroupFields(undefined)).toBeNull();
    return;
  }
  if (meta.type !== "group") {
    expect(getGroupFields(meta)).toBeNull();
    return;
  }
  const fields = getGroupFields(meta);
  expect(fields).not.toBeNull();
  expect(fields?.participants).toEqual(meta.participants);
}

function undefinedIsNull(): void {
  expect(getGroupFields(undefined)).toBeNull();
}

function dmMetaIsNull(): void {
  expect(getGroupFields(DM_META)).toBeNull();
}

function groupWithMembers(): void {
  const fields = getGroupFields(PRESENT_WITH_MEMBERS_META);
  expect(fields).toEqual({
    name: GROUP_NAME,
    participants: [PEER_ID, ALICE_ID, OWN_AGENT_ID],
  });
}

function groupNameOnly(): void {
  const fields = getGroupFields(PRESENT_NAME_ONLY_META);
  expect(fields).toEqual({ name: GROUP_NAME, participants: [] });
}

function absentCaseFraming(): void {
  expect(getGroupFields(undefined)).toBeNull();
  for (const markup of MARKUPS) {
    expect(fixtureFor("absent", markup)).toBe(NULL_SENTINEL);
  }
}

function assertPresentMatchesFixture(
  meta: EnrichedConversationMeta,
  caseName: string,
  markup: CrossConvMarkup,
): void {
  const fields = getGroupFields(meta);
  if (fields === null) throw new Error("expected non-null group fields");
  const out = formatGroupBlock(fields, { markup });
  expect(`${out}\n`).toBe(fixtureFor(caseName, markup));
}

function delegatesToFormatter(): void {
  const fields = getGroupFields(PRESENT_WITH_MEMBERS_META);
  if (fields === null) throw new Error("expected non-null group fields");
  const formatter: GroupFormatter = (f) =>
    `${CUSTOM_FORMATTER_OUTPUT}:${f.participants.length}`;
  expect(formatGroupBlock(fields, { formatter })).toBe(
    `${CUSTOM_FORMATTER_OUTPUT}:3`,
  );
}
