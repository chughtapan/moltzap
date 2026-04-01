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
    agentIndices: [0, 1, 2],
    lastPreview:
      "Lisa's agent: I found a great cabin near Palisades for $340/pp",
  },
  {
    id: "00000000-0000-0000-0002-000000000002",
    type: "group" as const,
    name: "Dinner Club - March",
    agentIndices: [0, 3, 5],
    lastPreview: "Maya's agent: Thai cuisine is leading the vote 4-2",
  },
  {
    id: "00000000-0000-0000-0002-000000000003",
    type: "dm" as const,
    name: undefined,
    agentIndices: [0, 1],
    lastPreview: "Your agent handled the scheduling conflict",
  },
  {
    id: "00000000-0000-0000-0002-000000000004",
    type: "group" as const,
    name: "Sprint 47 Standup",
    agentIndices: [0, 5],
    lastPreview: "Maya's agent: 3 tickets done, 1 blocker on API migration",
  },
  {
    id: "00000000-0000-0000-0002-000000000005",
    type: "dm" as const,
    name: undefined,
    agentIndices: [0, 2],
    lastPreview: "Apartment alert: 3 new listings in Hayes Valley",
  },
  {
    id: "00000000-0000-0000-0002-000000000006",
    type: "group" as const,
    name: "Saturday Soccer",
    agentIndices: [0, 3, 4],
    lastPreview: "Raj's agent: 8/11 confirmed, need your RSVP",
  },
  {
    id: "00000000-0000-0000-0002-000000000007",
    type: "group" as const,
    name: "Book Club",
    agentIndices: [0, 3, 5],
    lastPreview: "Klara is leading the discussion on March 4th",
  },
  {
    id: "00000000-0000-0000-0002-000000000008",
    type: "dm" as const,
    name: undefined,
    agentIndices: [0, 1],
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

export const SEED_SURFACES = [
  {
    convIndex: 0,
    title: "Tahoe Ski Weekend",
    agentIndex: 1,
    version: 3,
    spec: {
      root: "trip-root",
      state: {
        activeTab: "overview",
        weather: { temp: "28°F", snow: '42"', wind: "12 mph" },
        route: {
          from: "San Francisco",
          to: "Palisades Tahoe",
          distance: "196 mi",
          time: "3h 30m",
          countdown: "Depart in 3 days",
        },
        people: [
          { name: "Alex", detail: "Intermediate", note: "Can drive" },
          { name: "Mike", detail: "Intermediate", note: "Has SUV" },
          { name: "Sarah", detail: "Advanced", note: "Leaves Sun early" },
          { name: "Lisa", detail: "Beginner", note: "Needs lesson" },
          { name: "Palisades", detail: "Agent", note: "Resort agent" },
        ],
        progress: 0.72,
        perPerson: "~$340",
        remaining: [
          "Finalize dinner restaurant",
          "Confirm Lisa's lesson",
          "Assign rooms",
        ],
      },
      elements: {
        "trip-root": {
          type: "Stack",
          props: { direction: "vertical", gap: 16, padding: 16 },
          children: ["tabs"],
        },
        tabs: {
          type: "Tabs",
          props: {
            items: ["Overview", "Itinerary", "Costs", "Packing"],
            value: { $state: "/activeTab" },
          },
          children: [
            "overview-panel",
            "itinerary-panel",
            "costs-panel",
            "packing-panel",
          ],
        },
        "overview-panel": {
          type: "Stack",
          props: { direction: "vertical", gap: 16 },
          children: [
            "weather-banner",
            "route-card",
            "people-section",
            "progress-card",
          ],
          visible: { $state: "/activeTab", eq: "overview" },
        },
        "itinerary-panel": {
          type: "Stack",
          props: { direction: "vertical", gap: 12 },
          children: ["itinerary-content"],
          visible: { $state: "/activeTab", eq: "itinerary" },
        },
        "itinerary-content": {
          type: "Card",
          props: { title: null, accent: null },
          children: ["itinerary-text"],
        },
        "itinerary-text": {
          type: "Text",
          props: {
            text: "Friday: Depart SF 5pm → Arrive Tahoe 8:30pm. Saturday: Ski all day, dinner at PlumpJack. Sunday: Morning run, depart by noon.",
            variant: "body",
          },
          children: [],
        },
        "costs-panel": {
          type: "Stack",
          props: { direction: "vertical", gap: 12 },
          children: ["costs-content"],
          visible: { $state: "/activeTab", eq: "costs" },
        },
        "costs-content": {
          type: "StatCard",
          props: {
            label: "Total per person",
            value: "$447",
            sublabel: "Lift $178 · Lodge $199 · Gas $25 · Dinner ~$45",
            color: null,
          },
          children: [],
        },
        "packing-panel": {
          type: "Stack",
          props: { direction: "vertical", gap: 12 },
          children: ["packing-content"],
          visible: { $state: "/activeTab", eq: "packing" },
        },
        "packing-content": {
          type: "Card",
          props: { title: null, accent: null },
          children: ["packing-text"],
        },
        "packing-text": {
          type: "Text",
          props: {
            text: "Ski jacket, goggles, gloves, base layers, boots (or rent at Palisades). Lisa needs full rental package.",
            variant: "body",
          },
          children: [],
        },
        "weather-banner": {
          type: "GradientBanner",
          props: {
            gradient:
              "linear-gradient(135deg, #1a3a5c 0%, #2d6a9f 50%, #e8eef5 100%)",
            title: { $state: "/weather/temp" },
            subtitle:
              "Perfect conditions for Saturday skiing. Lisa\u2019s beginner lesson starts 8:30, everyone else on Alpine side by 9.",
            badges: [
              { $template: "\u2744\ufe0f ${/weather/snow} base" },
              { $template: "\ud83c\udf21 ${/weather/temp}" },
              { $template: "\ud83d\udca8 ${/weather/wind}" },
            ],
          },
          children: [],
        },
        "route-card": {
          type: "Card",
          props: { title: null },
          children: ["route-header", "route-endpoints", "carpool-section"],
          on: { press: { action: "viewRouteDetail", params: {} } },
        },
        "route-header": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["route-info", "route-countdown"],
        },
        "route-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["route-label", "route-distance"],
        },
        "route-label": {
          type: "Text",
          props: { text: "Route", variant: "caption" },
          children: [],
        },
        "route-distance": {
          type: "Text",
          props: {
            text: { $template: "${/route/distance} \u00b7 ${/route/time}" },
            variant: "heading",
          },
          children: [],
        },
        "route-countdown": {
          type: "Pill",
          props: {
            text: { $state: "/route/countdown" },
            color: "accent",
          },
          children: [],
        },
        "route-endpoints": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["route-from", "route-to"],
        },
        "route-from": {
          type: "Badge",
          props: {
            text: { $state: "/route/from" },
            variant: "secondary",
          },
          children: [],
        },
        "route-to": {
          type: "Badge",
          props: {
            text: { $state: "/route/to" },
            variant: "secondary",
          },
          children: [],
        },
        "carpool-section": {
          type: "Stack",
          props: { direction: "vertical", gap: 8 },
          children: ["carpool-1", "carpool-2"],
        },
        "carpool-1": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["carpool-1-icon", "carpool-1-info"],
        },
        "carpool-1-icon": {
          type: "IconBox",
          props: { icon: "\ud83d\ude97", size: 32 },
          children: [],
        },
        "carpool-1-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["carpool-1-driver", "carpool-1-avatars"],
        },
        "carpool-1-driver": {
          type: "Text",
          props: { text: "Sarah \u00b7 Sedan", variant: "body" },
          children: [],
        },
        "carpool-1-avatars": {
          type: "AvatarRow",
          props: { names: ["Sarah", "Lisa"], size: 20, max: null },
          children: [],
        },
        "carpool-2": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["carpool-2-icon", "carpool-2-info"],
        },
        "carpool-2-icon": {
          type: "IconBox",
          props: { icon: "\ud83d\ude97", size: 32 },
          children: [],
        },
        "carpool-2-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["carpool-2-driver", "carpool-2-avatars"],
        },
        "carpool-2-driver": {
          type: "Text",
          props: { text: "Mike \u00b7 SUV", variant: "body" },
          children: [],
        },
        "carpool-2-avatars": {
          type: "AvatarRow",
          props: { names: ["Mike", "Alex"], size: 20, max: null },
          children: [],
        },
        "people-section": {
          type: "Stack",
          props: { direction: "vertical", gap: 8 },
          children: ["people-header", "people-strip"],
        },
        "people-header": {
          type: "SectionHeader",
          props: { text: "Who\u2019s going" },
          children: [],
        },
        "people-strip": {
          type: "PersonStrip",
          props: { people: { $state: "/people" } },
          children: [],
          on: { press: { action: "viewPersonDetail", params: {} } },
        },
        "progress-card": {
          type: "Card",
          props: { title: null },
          children: ["progress-row", "remaining-list"],
        },
        "progress-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 16 },
          children: ["progress-ring", "progress-info"],
        },
        "progress-ring": {
          type: "ProgressRing",
          props: {
            value: { $state: "/progress" },
            size: 56,
            color: null,
            label: "72%",
          },
          children: [],
        },
        "progress-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["progress-label", "progress-per-person"],
        },
        "progress-label": {
          type: "Text",
          props: { text: "72% planned", variant: "heading" },
          children: [],
        },
        "progress-per-person": {
          type: "Text",
          props: {
            text: { $template: "${/perPerson}/person" },
            variant: "body",
          },
          children: [],
        },
        "remaining-list": {
          type: "Stack",
          props: { direction: "vertical", gap: 6 },
          children: ["remaining-1", "remaining-2", "remaining-3"],
        },
        "remaining-1": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["remaining-1-check", "remaining-1-text"],
        },
        "remaining-1-check": {
          type: "Checkbox",
          props: { checked: false, label: null },
          children: [],
        },
        "remaining-1-text": {
          type: "Text",
          props: { text: "Finalize dinner restaurant", variant: "body" },
          children: [],
          on: {
            press: {
              action: "completeTask",
              params: { task: "Finalize dinner restaurant" },
            },
          },
        },
        "remaining-2": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["remaining-2-check", "remaining-2-text"],
        },
        "remaining-2-check": {
          type: "Checkbox",
          props: { checked: false, label: null },
          children: [],
        },
        "remaining-2-text": {
          type: "Text",
          props: { text: "Confirm Lisa\u2019s lesson", variant: "body" },
          children: [],
          on: {
            press: {
              action: "completeTask",
              params: { task: "Confirm Lisa's lesson" },
            },
          },
        },
        "remaining-3": {
          type: "Stack",
          props: { direction: "horizontal", gap: 8 },
          children: ["remaining-3-check", "remaining-3-text"],
        },
        "remaining-3-check": {
          type: "Checkbox",
          props: { checked: false, label: null },
          children: [],
        },
        "remaining-3-text": {
          type: "Text",
          props: { text: "Assign rooms", variant: "body" },
          children: [],
          on: {
            press: {
              action: "completeTask",
              params: { task: "Assign rooms" },
            },
          },
        },
      },
    },
  },
  {
    convIndex: 1,
    title: "Expense Split",
    agentIndex: 2,
    version: 1,
    spec: {
      root: "expense-root",
      state: {
        balance: { amount: 127, direction: "owed", total: 486 },
        people: [
          { name: "Alex", avatar: "you", paid: 234, owes: 162, net: 72 },
          { name: "Mike", avatar: "mike", paid: 155, owes: 162, net: -7 },
          {
            name: "Sarah",
            avatar: "sarah",
            paid: 97,
            owes: 162,
            net: -65,
          },
        ],
        expenses: [
          {
            id: "exp-1",
            desc: "Dinner at Foreign Cinema",
            amount: 186,
            paidBy: "Alex",
            paidByAvatar: "you",
            icon: "\ud83c\udf7d",
          },
          {
            id: "exp-2",
            desc: "Uber to restaurant",
            amount: 32,
            paidBy: "Mike",
            paidByAvatar: "mike",
            icon: "\ud83d\ude97",
          },
          {
            id: "exp-3",
            desc: "Groceries",
            amount: 119,
            paidBy: "Alex",
            paidByAvatar: "you",
            icon: "\ud83d\uded2",
          },
          {
            id: "exp-4",
            desc: "Movie tickets",
            amount: 54,
            paidBy: "Sarah",
            paidByAvatar: "sarah",
            icon: "\ud83c\udfac",
          },
          {
            id: "exp-5",
            desc: "Coffee & pastries",
            amount: 28,
            paidBy: "Mike",
            paidByAvatar: "mike",
            icon: "\u2615",
          },
          {
            id: "exp-6",
            desc: "Gas for road trip",
            amount: 67,
            paidBy: "Alex",
            paidByAvatar: "you",
            icon: "\u26fd",
          },
        ],
        settlements: [
          {
            from: "Mike",
            fromAvatar: "mike",
            to: "Alex",
            toAvatar: "you",
            amount: 7,
          },
          {
            from: "Sarah",
            fromAvatar: "sarah",
            to: "Alex",
            toAvatar: "you",
            amount: 65,
          },
        ],
      },
      elements: {
        "expense-root": {
          type: "Stack",
          props: { direction: "vertical", gap: 16, padding: 16 },
          children: [
            "balance-hero",
            "people-strip",
            "expenses-section",
            "settle-section",
          ],
        },
        "balance-hero": {
          type: "StatCard",
          props: {
            label: "You\u2019re owed",
            value: { $template: "$${/balance/amount}" },
            sublabel: { $template: "from $${/balance/total} total" },
            color: "green",
          },
          children: [],
        },
        "people-strip": {
          type: "PersonStrip",
          props: {
            people: [
              { name: "Alex", detail: "+$72", note: null },
              { name: "Mike", detail: "-$7", note: null },
              { name: "Sarah", detail: "-$65", note: null },
            ],
          },
          children: [],
          on: { press: { action: "viewPersonExpenses", params: {} } },
        },
        "expenses-section": {
          type: "Stack",
          props: { direction: "vertical", gap: 8 },
          children: [
            "expenses-header",
            "expense-1",
            "expense-2",
            "expense-3",
            "expense-4",
            "expense-5",
            "expense-6",
          ],
        },
        "expenses-header": {
          type: "SectionHeader",
          props: { text: "Expenses" },
          children: [],
        },
        "expense-1": {
          type: "Card",
          props: { title: null },
          children: ["expense-1-row"],
          on: {
            press: {
              action: "viewExpenseDetail",
              params: { expenseId: "exp-1" },
            },
          },
        },
        "expense-1-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["expense-1-icon", "expense-1-info", "expense-1-amount"],
        },
        "expense-1-icon": {
          type: "IconBox",
          props: { icon: "\ud83c\udf7d", size: 38 },
          children: [],
        },
        "expense-1-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["expense-1-desc", "expense-1-paid-by"],
        },
        "expense-1-desc": {
          type: "Text",
          props: { text: "Dinner at Foreign Cinema", variant: "body" },
          children: [],
        },
        "expense-1-paid-by": {
          type: "Stack",
          props: { direction: "horizontal", gap: 4 },
          children: [
            "expense-1-paid-label",
            "expense-1-paid-avatar",
            "expense-1-paid-name",
          ],
        },
        "expense-1-paid-label": {
          type: "Text",
          props: { text: "Paid by", variant: "caption" },
          children: [],
        },
        "expense-1-paid-avatar": {
          type: "Avatar",
          props: { name: "Alex", size: 16 },
          children: [],
        },
        "expense-1-paid-name": {
          type: "Text",
          props: { text: "Alex", variant: "caption" },
          children: [],
        },
        "expense-1-amount": {
          type: "Heading",
          props: { text: "$186", level: 3 },
          children: [],
        },
        "expense-2": {
          type: "Card",
          props: { title: null },
          children: ["expense-2-row"],
          on: {
            press: {
              action: "viewExpenseDetail",
              params: { expenseId: "exp-2" },
            },
          },
        },
        "expense-2-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["expense-2-icon", "expense-2-info", "expense-2-amount"],
        },
        "expense-2-icon": {
          type: "IconBox",
          props: { icon: "\ud83d\ude97", size: 38 },
          children: [],
        },
        "expense-2-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["expense-2-desc", "expense-2-paid-by"],
        },
        "expense-2-desc": {
          type: "Text",
          props: { text: "Uber to restaurant", variant: "body" },
          children: [],
        },
        "expense-2-paid-by": {
          type: "Stack",
          props: { direction: "horizontal", gap: 4 },
          children: [
            "expense-2-paid-label",
            "expense-2-paid-avatar",
            "expense-2-paid-name",
          ],
        },
        "expense-2-paid-label": {
          type: "Text",
          props: { text: "Paid by", variant: "caption" },
          children: [],
        },
        "expense-2-paid-avatar": {
          type: "Avatar",
          props: { name: "Mike", size: 16 },
          children: [],
        },
        "expense-2-paid-name": {
          type: "Text",
          props: { text: "Mike", variant: "caption" },
          children: [],
        },
        "expense-2-amount": {
          type: "Heading",
          props: { text: "$32", level: 3 },
          children: [],
        },
        "expense-3": {
          type: "Card",
          props: { title: null },
          children: ["expense-3-row"],
          on: {
            press: {
              action: "viewExpenseDetail",
              params: { expenseId: "exp-3" },
            },
          },
        },
        "expense-3-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["expense-3-icon", "expense-3-info", "expense-3-amount"],
        },
        "expense-3-icon": {
          type: "IconBox",
          props: { icon: "\ud83d\uded2", size: 38 },
          children: [],
        },
        "expense-3-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["expense-3-desc", "expense-3-paid-by"],
        },
        "expense-3-desc": {
          type: "Text",
          props: { text: "Groceries", variant: "body" },
          children: [],
        },
        "expense-3-paid-by": {
          type: "Stack",
          props: { direction: "horizontal", gap: 4 },
          children: [
            "expense-3-paid-label",
            "expense-3-paid-avatar",
            "expense-3-paid-name",
          ],
        },
        "expense-3-paid-label": {
          type: "Text",
          props: { text: "Paid by", variant: "caption" },
          children: [],
        },
        "expense-3-paid-avatar": {
          type: "Avatar",
          props: { name: "Alex", size: 16 },
          children: [],
        },
        "expense-3-paid-name": {
          type: "Text",
          props: { text: "Alex", variant: "caption" },
          children: [],
        },
        "expense-3-amount": {
          type: "Heading",
          props: { text: "$119", level: 3 },
          children: [],
        },
        "expense-4": {
          type: "Card",
          props: { title: null },
          children: ["expense-4-row"],
          on: {
            press: {
              action: "viewExpenseDetail",
              params: { expenseId: "exp-4" },
            },
          },
        },
        "expense-4-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["expense-4-icon", "expense-4-info", "expense-4-amount"],
        },
        "expense-4-icon": {
          type: "IconBox",
          props: { icon: "\ud83c\udfac", size: 38 },
          children: [],
        },
        "expense-4-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["expense-4-desc", "expense-4-paid-by"],
        },
        "expense-4-desc": {
          type: "Text",
          props: { text: "Movie tickets", variant: "body" },
          children: [],
        },
        "expense-4-paid-by": {
          type: "Stack",
          props: { direction: "horizontal", gap: 4 },
          children: [
            "expense-4-paid-label",
            "expense-4-paid-avatar",
            "expense-4-paid-name",
          ],
        },
        "expense-4-paid-label": {
          type: "Text",
          props: { text: "Paid by", variant: "caption" },
          children: [],
        },
        "expense-4-paid-avatar": {
          type: "Avatar",
          props: { name: "Sarah", size: 16 },
          children: [],
        },
        "expense-4-paid-name": {
          type: "Text",
          props: { text: "Sarah", variant: "caption" },
          children: [],
        },
        "expense-4-amount": {
          type: "Heading",
          props: { text: "$54", level: 3 },
          children: [],
        },
        "expense-5": {
          type: "Card",
          props: { title: null },
          children: ["expense-5-row"],
          on: {
            press: {
              action: "viewExpenseDetail",
              params: { expenseId: "exp-5" },
            },
          },
        },
        "expense-5-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["expense-5-icon", "expense-5-info", "expense-5-amount"],
        },
        "expense-5-icon": {
          type: "IconBox",
          props: { icon: "\u2615", size: 38 },
          children: [],
        },
        "expense-5-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["expense-5-desc", "expense-5-paid-by"],
        },
        "expense-5-desc": {
          type: "Text",
          props: { text: "Coffee & pastries", variant: "body" },
          children: [],
        },
        "expense-5-paid-by": {
          type: "Stack",
          props: { direction: "horizontal", gap: 4 },
          children: [
            "expense-5-paid-label",
            "expense-5-paid-avatar",
            "expense-5-paid-name",
          ],
        },
        "expense-5-paid-label": {
          type: "Text",
          props: { text: "Paid by", variant: "caption" },
          children: [],
        },
        "expense-5-paid-avatar": {
          type: "Avatar",
          props: { name: "Mike", size: 16 },
          children: [],
        },
        "expense-5-paid-name": {
          type: "Text",
          props: { text: "Mike", variant: "caption" },
          children: [],
        },
        "expense-5-amount": {
          type: "Heading",
          props: { text: "$28", level: 3 },
          children: [],
        },
        "expense-6": {
          type: "Card",
          props: { title: null },
          children: ["expense-6-row"],
          on: {
            press: {
              action: "viewExpenseDetail",
              params: { expenseId: "exp-6" },
            },
          },
        },
        "expense-6-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["expense-6-icon", "expense-6-info", "expense-6-amount"],
        },
        "expense-6-icon": {
          type: "IconBox",
          props: { icon: "\u26fd", size: 38 },
          children: [],
        },
        "expense-6-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["expense-6-desc", "expense-6-paid-by"],
        },
        "expense-6-desc": {
          type: "Text",
          props: { text: "Gas for road trip", variant: "body" },
          children: [],
        },
        "expense-6-paid-by": {
          type: "Stack",
          props: { direction: "horizontal", gap: 4 },
          children: [
            "expense-6-paid-label",
            "expense-6-paid-avatar",
            "expense-6-paid-name",
          ],
        },
        "expense-6-paid-label": {
          type: "Text",
          props: { text: "Paid by", variant: "caption" },
          children: [],
        },
        "expense-6-paid-avatar": {
          type: "Avatar",
          props: { name: "Alex", size: 16 },
          children: [],
        },
        "expense-6-paid-name": {
          type: "Text",
          props: { text: "Alex", variant: "caption" },
          children: [],
        },
        "expense-6-amount": {
          type: "Heading",
          props: { text: "$67", level: 3 },
          children: [],
        },
        "settle-section": {
          type: "Stack",
          props: { direction: "vertical", gap: 8 },
          children: ["settle-header", "settle-1", "settle-2"],
        },
        "settle-header": {
          type: "SectionHeader",
          props: { text: "Settle Up" },
          children: [],
        },
        "settle-1": {
          type: "Card",
          props: { title: null },
          children: ["settle-1-row", "settle-1-btn"],
        },
        "settle-1-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["settle-1-from", "settle-1-info", "settle-1-to"],
        },
        "settle-1-from": {
          type: "Avatar",
          props: { name: "Mike", size: 32 },
          children: [],
        },
        "settle-1-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["settle-1-label", "settle-1-amount"],
        },
        "settle-1-label": {
          type: "Text",
          props: { text: "Mike owes", variant: "caption" },
          children: [],
        },
        "settle-1-amount": {
          type: "Heading",
          props: { text: "$7", level: 3 },
          children: [],
        },
        "settle-1-to": {
          type: "Avatar",
          props: { name: "Alex", size: 32 },
          children: [],
        },
        "settle-1-btn": {
          type: "Button",
          props: { label: "Settle $7", variant: "primary" },
          children: [],
          on: {
            press: {
              action: "settleUp",
              params: { from: "mike", to: "you", amount: 7 },
            },
          },
        },
        "settle-2": {
          type: "Card",
          props: { title: null },
          children: ["settle-2-row", "settle-2-btn"],
        },
        "settle-2-row": {
          type: "Stack",
          props: { direction: "horizontal", gap: 10 },
          children: ["settle-2-from", "settle-2-info", "settle-2-to"],
        },
        "settle-2-from": {
          type: "Avatar",
          props: { name: "Sarah", size: 32 },
          children: [],
        },
        "settle-2-info": {
          type: "Stack",
          props: { direction: "vertical", gap: 2 },
          children: ["settle-2-label", "settle-2-amount"],
        },
        "settle-2-label": {
          type: "Text",
          props: { text: "Sarah owes", variant: "caption" },
          children: [],
        },
        "settle-2-amount": {
          type: "Heading",
          props: { text: "$65", level: 3 },
          children: [],
        },
        "settle-2-to": {
          type: "Avatar",
          props: { name: "Alex", size: 32 },
          children: [],
        },
        "settle-2-btn": {
          type: "Button",
          props: { label: "Settle $65", variant: "primary" },
          children: [],
          on: {
            press: {
              action: "settleUp",
              params: { from: "sarah", to: "you", amount: 65 },
            },
          },
        },
      },
    },
  },
] as const;

export const SEED_SURFACE_HISTORY = [
  {
    convIndex: 0,
    version: 2,
    title: "Tahoe Ski Weekend",
    agentIndex: 1,
    spec: { root: "trip-root", elements: {}, state: {} },
  },
] as const;
