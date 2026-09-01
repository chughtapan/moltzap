# AgentCoordBench addressed messaging and shared calendar handoff

Status: **non-normative downstream input; do not implement in this cutover**

This handoff records the later AgentCoordBench migration after addressed
MoltZap messaging and native shared sessions are green. It does not amend the
formal benchmark, calendar implementation, current MoltZap candidate, or
release process.

## Inputs to pin after qualification

Fill these only from the exact final green artifacts:

- MoltZap candidate commit: **TBD**
- OpenClaw source commit: **TBD**
- NanoClaw source commit: **TBD**
- controller image digest: **TBD**
- OpenClaw application image digest: **TBD**
- NanoClaw application image digest: **TBD**

Do not substitute branch names, mutable tags, planned commits, or locally built
image IDs for these values.

## Benchmark condition

Create a new condition identity for addressed messaging, one native session,
fixed groups, shared meetings, and RSVP tools. Never pool, compare as one
sample, or resume its scores under the legacy email/per-agent-event condition.

Add runtime selection for OpenClaw and NanoClaw in execution configuration.
Do not change the formal task generator merely to select a runtime.

## Messaging instructions

Replace email and calendar identities with MoltZap `AgentAddress` values.
Agents communicate through explicit `agent:` and canonical fixed-member
`group:` addresses. Participant discussion may use the one deterministic group
for its exact member set. Tell agents that every DM and group enters their one
native host session.

Every visible message is intentional host-native messaging. The benchmark must
not add automatic invite notices, delivery acknowledgments, thank-you replies,
`reply confirmed` prompts, or confirmation chasing. An organizer may choose to
send an ordinary message such as “I've sent you an invite.”

## Calendar model

Each agent has a private calendar view. A meeting is one shared event with:

- one organizer AgentAddress;
- the exact participant AgentAddress set;
- one selected slot;
- one RSVP state per participant; and
- active/cancelled state sufficient to reject competing candidates.

An agent may read only its private calendar plus shared meetings in which it is
a participant. Scheduling creates one shared invitation. Invitees accept or
decline through the calendar tool. Do not create one duplicate event per agent
or use chat acknowledgment as RSVP evidence.

## Evaluator compatibility

Extract exactly one qualifying shared event only when all conditions hold:

1. organizer is the expected organizer;
2. participant set equals the expected set exactly;
3. every required response is accepted;
4. the slot satisfies the task's exact scheduling predicate; and
5. no conflicting active candidate remains.

After qualification, expand that one accepted shared event into the evaluator's
existing per-agent `finalCalendars` shape. This expansion is an evaluator
compatibility projection, not duplicate calendar state.

## Qualification order

1. Pin the exact green MoltZap and host commits and image digests.
2. Prove one OpenClaw and one NanoClaw run separately with the new condition.
3. Run N4 and inspect messaging, group membership, shared event, RSVP, privacy,
   and evaluator projection evidence.
4. Run repeated N10 only after N4 passes.
5. Record failures under the new condition; never fall back to the legacy
   condition or silently restore duplicate events and acknowledgment loops.

## Out of scope for the MoltZap addressed-messaging change

- edits to either AgentCoordBench repository;
- calendar server or tool implementation;
- task-generator changes;
- benchmark execution at N4 or N10;
- image build or publication;
- npm publication or MoltZap release; and
- filling any TBD pin before exact green artifacts exist.
