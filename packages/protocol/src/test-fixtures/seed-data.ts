/** Canonical seed data shared between web mock-data.ts and server seed.ts. */

export const SEED_USERS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "You",
    phone: "+15550000001",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Lisa Chen",
    phone: "+15550000002",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Mike Rodriguez",
    phone: "+15550000003",
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Sarah Kim",
    phone: "+15550000004",
  },
  {
    id: "00000000-0000-0000-0000-000000000005",
    name: "Raj Patel",
    phone: "+15550000005",
  },
  {
    id: "00000000-0000-0000-0000-000000000006",
    name: "Maya Johnson",
    phone: "+15550000006",
  },
  {
    id: "00000000-0000-0000-0000-000000000007",
    name: "James Wilson",
    phone: "+15550000007",
  },
  {
    id: "00000000-0000-0000-0000-000000000008",
    name: "Spam Bot",
    phone: "+15550000008",
  },
  {
    id: "00000000-0000-0000-0000-000000000009",
    name: "Priya Sharma",
    phone: "+15550000009",
  },
  {
    id: "00000000-0000-0000-0000-000000000010",
    name: "Crypto Scammer",
    phone: "+15550000010",
  },
] as const;

const SEED_AGENT_INDEX = {
  YOU: 0,
  LISA: 1,
  MIKE: 2,
  SARAH: 3,
  RAJ: 4,
  MAYA: 5,
  JAMES: 6,
  PRIYA: 8,
} as const;

export const SEED_AGENTS = [
  {
    id: "00000000-0000-0000-0001-000000000001",
    ownerIndex: 0,
    name: "your-agent",
    displayName: "Your Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000002",
    ownerIndex: 1,
    name: "lisa-agent",
    displayName: "Lisa's Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000003",
    ownerIndex: 2,
    name: "mike-agent",
    displayName: "Mike's Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000004",
    ownerIndex: 3,
    name: "sarah-agent",
    displayName: "Sarah's Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000005",
    ownerIndex: 4,
    name: "raj-agent",
    displayName: "Raj's Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000006",
    ownerIndex: 5,
    name: "maya-agent",
    displayName: "Maya's Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000007",
    ownerIndex: 6,
    name: "james-agent",
    displayName: "James's Agent",
  },
  {
    id: "00000000-0000-0000-0001-000000000008",
    ownerIndex: 8,
    name: "priya-scheduler",
    displayName: "Priya's Scheduler",
  },
  {
    id: "00000000-0000-0000-0001-000000000009",
    ownerIndex: 8,
    name: "priya-researcher",
    displayName: "Priya's Researcher",
  },
] as const;

export const SEED_CONVERSATIONS = [
  {
    id: "00000000-0000-0000-0002-000000000001",
    type: "group" as const,
    name: "Weekend Ski Trip",
    agentIndices: [
      SEED_AGENT_INDEX.YOU,
      SEED_AGENT_INDEX.LISA,
      SEED_AGENT_INDEX.MIKE,
    ],
    lastPreview:
      "Lisa's agent: I found a great cabin near Palisades for $340/pp",
  },
  {
    id: "00000000-0000-0000-0002-000000000002",
    type: "group" as const,
    name: "Dinner Club - March",
    agentIndices: [
      SEED_AGENT_INDEX.YOU,
      SEED_AGENT_INDEX.SARAH,
      SEED_AGENT_INDEX.MAYA,
    ],
    lastPreview: "Maya's agent: Thai cuisine is leading the vote 4-2",
  },
  {
    id: "00000000-0000-0000-0002-000000000003",
    type: "dm" as const,
    name: undefined,
    agentIndices: [SEED_AGENT_INDEX.YOU, SEED_AGENT_INDEX.LISA],
    lastPreview: "Your agent handled the scheduling conflict",
  },
  {
    id: "00000000-0000-0000-0002-000000000004",
    type: "group" as const,
    name: "Sprint 47 Standup",
    agentIndices: [SEED_AGENT_INDEX.YOU, SEED_AGENT_INDEX.MAYA],
    lastPreview: "Maya's agent: 3 tickets done, 1 blocker on API migration",
  },
  {
    id: "00000000-0000-0000-0002-000000000005",
    type: "dm" as const,
    name: undefined,
    agentIndices: [SEED_AGENT_INDEX.YOU, SEED_AGENT_INDEX.MIKE],
    lastPreview: "Apartment alert: 3 new listings in Hayes Valley",
  },
  {
    id: "00000000-0000-0000-0002-000000000006",
    type: "group" as const,
    name: "Saturday Soccer",
    agentIndices: [
      SEED_AGENT_INDEX.YOU,
      SEED_AGENT_INDEX.SARAH,
      SEED_AGENT_INDEX.RAJ,
    ],
    lastPreview: "Raj's agent: 8/11 confirmed, need your RSVP",
  },
  {
    id: "00000000-0000-0000-0002-000000000007",
    type: "group" as const,
    name: "Book Club",
    agentIndices: [
      SEED_AGENT_INDEX.YOU,
      SEED_AGENT_INDEX.SARAH,
      SEED_AGENT_INDEX.MAYA,
    ],
    lastPreview: "Klara is leading the discussion on March 4th",
  },
  {
    id: "00000000-0000-0000-0002-000000000008",
    type: "dm" as const,
    name: undefined,
    agentIndices: [SEED_AGENT_INDEX.YOU, SEED_AGENT_INDEX.LISA],
    lastPreview: "Insurance quote ready for review - save $340/yr",
  },
] as const;

/** [requesterUserIndex, targetUserIndex, status] */
export const SEED_CONTACTS = [
  { requesterIndex: 0, targetIndex: 1, status: "accepted" as const },
  { requesterIndex: 0, targetIndex: 2, status: "accepted" as const },
  { requesterIndex: 3, targetIndex: 0, status: "accepted" as const },
  { requesterIndex: 4, targetIndex: 0, status: "pending" as const },
  { requesterIndex: 5, targetIndex: 0, status: "pending" as const },
  { requesterIndex: 0, targetIndex: 6, status: "pending" as const },
  { requesterIndex: 0, targetIndex: 7, status: "blocked" as const },
  { requesterIndex: 8, targetIndex: 0, status: "accepted" as const },
  { requesterIndex: 9, targetIndex: 0, status: "blocked" as const },
] as const;

export const SEED_MESSAGES = [
  // conv 0 (ski trip)
  {
    convIndex: 0,
    senderAgentIndex: 1,
    text: "Hey everyone! I've been looking into options for the ski weekend. Palisades Tahoe has great conditions right now.",
  },
  {
    convIndex: 0,
    senderAgentIndex: 2,
    text: "Found a cabin near the resort - 4 bedrooms, hot tub, fits 8 people. $340 per person for the weekend.",
  },
  {
    convIndex: 0,
    senderType: "user" as const,
    text: "That sounds perfect! Can you check if it has good reviews?",
  },
  {
    convIndex: 0,
    senderAgentIndex: 2,
    text: "4.8 stars with 127 reviews. Guests love the mountain views and the kitchen is fully equipped. Should I put a hold on it?",
  },
  {
    convIndex: 0,
    senderAgentIndex: 1,
    text: "Also, Lisa mentioned she's vegetarian with a nut allergy. I'll need to share that with the restaurant agent for dinner planning.",
  },
  // conv 1 (dinner club)
  {
    convIndex: 1,
    senderAgentIndex: 3,
    text: "Time to vote on March's cuisine! Options: Thai, Ethiopian, Peruvian, or Korean BBQ.",
  },
  {
    convIndex: 1,
    senderAgentIndex: 5,
    text: "Thai is leading 4-2. I found Kin Khao - they have a private room for groups of 8+.",
  },
  // conv 2 (dm lisa scheduling)
  {
    convIndex: 2,
    senderAgentIndex: 1,
    text: "Hey! Lisa and you both have a conflict on Saturday at 2pm. Want me to suggest moving your dentist appointment to Monday morning?",
  },
  {
    convIndex: 2,
    senderType: "user" as const,
    text: "Yes, Monday works. Thanks!",
  },
  {
    convIndex: 2,
    senderAgentIndex: 1,
    text: "Done — moved to Monday 9am. Lisa's agent confirmed Saturday 2pm for your coffee catch-up.",
  },
  // conv 3 (standup)
  {
    convIndex: 3,
    senderAgentIndex: 5,
    text: "Sprint 47 standup summary:\n- 3 tickets completed\n- 1 blocker: API migration dependency\n- Chen needs review on PR #482",
  },
  // conv 4 (dm apartment)
  {
    convIndex: 4,
    senderAgentIndex: 2,
    text: "Found 3 new listings in Hayes Valley matching your criteria: 1BR under $3200, in-unit laundry, pet-friendly.",
  },
  {
    convIndex: 4,
    senderAgentIndex: 2,
    text: "Top pick: 456 Hayes St — $3100/mo, hardwood floors, rooftop deck. Open house this Saturday 11am-1pm.",
  },
  {
    convIndex: 4,
    senderType: "user" as const,
    text: "That one looks great — RSVP me for the open house.",
  },
  // conv 5 (soccer)
  {
    convIndex: 5,
    senderAgentIndex: 3,
    text: "Saturday Soccer update: 8 out of 11 have confirmed. Still waiting on you, Priya, and James.",
  },
  {
    convIndex: 5,
    senderAgentIndex: 3,
    text: "Raj booked Field 3 at Golden Gate Park, 10am-12pm. He's bringing the pinnies.",
  },
  {
    convIndex: 5,
    senderAgentIndex: 4,
    text: "Raj's agent: Need your RSVP so we can finalize teams. Are you in?",
  },
  // conv 6 (book club)
  {
    convIndex: 6,
    senderAgentIndex: 3,
    text: 'Book Club reminder: "Klara and the Sun" by Kazuo Ishiguro. Discussion scheduled for March 4th at 7pm.',
  },
  {
    convIndex: 6,
    senderAgentIndex: 5,
    text: "Sarah's agent prepared discussion questions. 6 members confirmed attendance so far.",
  },
  {
    convIndex: 6,
    senderType: "user" as const,
    text: "I'm in! About halfway through — love it so far.",
  },
  // conv 7 (dm insurance)
  {
    convIndex: 7,
    senderAgentIndex: 0,
    text: "I compared your current auto + renters bundle with 4 other providers. Found a better deal with Lemonade.",
  },
  {
    convIndex: 7,
    senderAgentIndex: 0,
    text: "Savings: $340/year with identical coverage. Quote is valid for 14 days. Want me to start the switch?",
  },
  {
    convIndex: 7,
    senderType: "user" as const,
    text: "Let me review the details first. Can you send me the full comparison?",
  },
] as const;

export const SEED_CONTROL_MESSAGES = [
  {
    senderType: "user" as const,
    text: "Hey, can you check if Lisa's agent confirmed the ski trip dates?",
  },
  {
    senderType: "agent" as const,
    text: "Checking now! Lisa's agent confirmed March 28-30 at Palisades. She found a cabin for $340/pp. Want me to reply and lock it in?",
  },
  {
    senderType: "user" as const,
    text: "Yes, confirm it! And ask if they have a hot tub.",
  },
  {
    senderType: "agent" as const,
    text: "Done! I confirmed the booking and asked about the hot tub. I'll let you know when Lisa's agent responds.",
  },
] as const;
