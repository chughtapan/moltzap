/**
 * @file Smoke RunSpec for the paper's scenario S2 (Professor Alvarez sets up a
 * staff meeting with three teaching assistants), used to see whether models
 * can drive the gather overlay through the stock `message` tool.
 *
 * The controller loads this module alone, so it imports only what the
 * controller image ships and carries its personas and calendars inline. They
 * follow the primo bench's persona template for `s1-group-dm`; the calendars
 * are one fixed instance whose consensus slots are Tue 15:00, Wed 10:00 and
 * Wed 13:00.
 *
 * `ARM` selects what the agents are told, never what code they run: every arm
 * uses the same agent image, and an agent that never writes a gather document
 * takes the stock send and delivery path.
 *
 * Grading is offline: each agent's `CALENDAR.md` and its daemon history export
 * are harvested into the ledger when the program ends.
 */

import { RunSpec } from "@moltzap/simulator";
import { openClawRuntime } from "@moltzap/simulator/agents";
import {
  applicationImageFromEnvironment,
  controllerServicesFromEnvironment,
} from "@moltzap/simulator/controller";
import { Duration, Effect } from "effect";

/** @type {"baseline" | "pairwise" | "shared"} */
const ARM = "baseline";

/** "shared" is the adapter default; "private" is the paper's E1 condition. */
const MESSAGING_MODE = "shared";
/** Runs through Claude Code on the owner's subscription (`CLAUDE_CODE_OAUTH_TOKEN`). */
const MODEL_ID = "anthropic/claude-opus-4-8";
/** How many teaching assistants join the professor; the paper sweeps 1, 3, 5, 7. */
const TA_COUNT = 7;
/** The professor's turns run one after another, so a larger group needs longer. */
const OBSERVATION_WINDOW = Duration.minutes(TA_COUNT > 3 ? 10 : 5);
const KICKOFF = "Can you set up next week's CSE455 staff meeting?";
const GATHER_DEADLINE_SECONDS = 180;

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_BY_PREFIX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };
const WORKING_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

const TA_NAMES = [
  "sarah",
  "john",
  "priya",
  "diego",
  "hana",
  "omar",
  "maya",
].slice(0, TA_COUNT);
const CONSENSUS_SLOTS = ["Tue 15:00", "Wed 10:00", "Wed 13:00"];
/** Each TA is also free for two of these three; every one is closed to some TA. */
const DECOY_SLOTS = ["Mon 10:00", "Mon 14:00", "Tue 11:00"];

/** Open one-hour slots per agent; every other working hour is a commitment. */
const OPEN_SLOTS = {
  alvarez: [...CONSENSUS_SLOTS, "Mon 10:00", "Tue 11:00", "Thu 14:00"],
  ...Object.fromEntries(
    TA_NAMES.map((name, index) => [
      name,
      [
        ...CONSENSUS_SLOTS,
        ...DECOY_SLOTS.filter((slot, decoy) => decoy !== index % 3),
      ],
    ]),
  ),
};

const PEOPLE = {
  alvarez: {
    principal: "Professor Alvarez",
    about:
      "who teaches CSE455 at the University of Washington. He has several teaching assistants (TAs).",
  },
  ...Object.fromEntries(
    TA_NAMES.map((name) => [
      name,
      {
        principal: name[0].toUpperCase() + name.slice(1),
        about: "a teaching assistant for CSE455, taught by Professor Alvarez.",
      },
    ]),
  ),
};

function clock(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function calendarFile(name) {
  const open = new Set(
    OPEN_SLOTS[name].map((slot) => {
      const [day, time] = slot.split(" ");
      return `${DAY_BY_PREFIX[day]}-${Number(time.slice(0, 2))}`;
    }),
  );
  const sections = DAYS.map((day, index) => {
    const busy = WORKING_HOURS.filter((hour) => !open.has(`${index}-${hour}`))
      .map((hour) => `${clock(hour)}-${clock(hour + 1)} - busy`)
      .join("\n");
    return `## ${day}\n\n${busy}`;
  });
  return `# Calendar: next week\n\n${sections.join("\n\n")}\n\n## Log\n`;
}

function gatherGuide(name) {
  if (ARM === "baseline") {
    return "";
  }
  const asker = [
    "",
    "## Collecting answers from several people",
    "",
    "When you need the same answer from several people, do not message them one by one.",
    "Send ONE `message` tool call (address it to any one of them) whose message text is exactly this JSON document and nothing else:",
    "",
    `{"gather": {"members": ["<name>", "<name>"], "deadlineSeconds": ${GATHER_DEADLINE_SECONDS}, "topology": "${ARM}"}, "message": "<your question>"}`,
    "",
    "Everyone listed receives the question. You then receive ONE message containing every answer and the names of anyone who did not answer. Wait for it; do not ask again meanwhile.",
  ];
  const answerer = [
    "",
    "## Answering a collected question",
    "",
    "A message ending in `Gather <id>: reply to <address>.` is a collected question. Answer it with ONE `message` tool call to exactly that address, whose message text is exactly this JSON document and nothing else:",
    "",
    '{"contribution": {"id": "<id>"}, "message": "<your answer>"}',
  ];
  return [...(name === "alvarez" ? asker : []), ...answerer].join("\n");
}

function persona(name) {
  const self = PEOPLE[name];
  const contacts = Object.entries(PEOPLE)
    .filter(([peer]) => peer !== name)
    .map(
      ([peer, facts]) =>
        `- ${facts.principal} (${peer}), ${facts.about} Address: \`agent:${peer}\``,
    )
    .join("\n");
  return [
    "# Identity",
    "",
    `You are \`${name}\`, the agent for ${self.principal}, ${self.about} You help with managing their calendar and messages.`,
    "",
    "# Calendar",
    "",
    "Working hours: Monday to Friday, 09:00-17:00. Do not schedule anything outside those hours.",
    "",
    "The schedule for next week is stored in `CALENDAR.md` in your workspace: one section per day, each commitment on its own line as `HH:MM-HH:MM - <what>`. Keep it up to date, and log your changes under `## Log`, one line each:",
    "",
    "- `BOOKED: <day> <start>-<end> with <name>`",
    "- `DECLINED: <name> - <reason>`",
    "- `DELETED: <day> <start>-<end> with <name>`",
    "",
    "# Communication",
    "",
    "To send someone a message, use the `message` tool with an address: `agent:<name>` reaches one agent.",
    "",
    "You can connect with others:",
    "",
    contacts,
    gatherGuide(name),
    "",
  ].join("\n");
}

function agent(name) {
  return openClawRuntime({
    applicationImage: applicationImageFromEnvironment(),
    startupTimeout: Duration.minutes(5),
    historyExport: true,
    harvestWorkspaceFiles: ["CALENDAR.md"],
    messagingMode: MESSAGING_MODE,
    modelId: MODEL_ID,
    agentRuntime: "claude-cli",
    tools: {
      allow: ["group:fs", "message"],
      sandbox: { tools: { allow: ["group:fs", "message"] } },
      elevated: { enabled: false },
      exec: { mode: "full" },
    },
    workspaceFiles: [
      { relativePath: "AGENTS.md", content: persona(name) },
      { relativePath: "CALENDAR.md", content: calendarFile(name) },
    ],
  });
}

export const runSpec = RunSpec.define({
  id: `moltzap.gather-s2-${ARM}-n${TA_COUNT}/v1`,
  events: [],
  agents: Object.fromEntries(
    ["alvarez", ...TA_NAMES].map((name) => [name, agent(name)]),
  ),
  cluster: controllerServicesFromEnvironment(),
  execute: (context) =>
    Effect.gen(function* () {
      const kickoff = yield* context.agents.alvarez.gateway
        .agent({ message: KICKOFF, idempotencyKey: `kickoff-${ARM}` })
        .pipe(Effect.either);
      yield* Effect.sleep(OBSERVATION_WINDOW);
      return {
        arm: ARM,
        kickoff: kickoff._tag === "Right" ? kickoff.right.status : "failed",
      };
    }),
});
