/**
 * `moltzap start &lt;name> &lt;participant>... [--message &lt;text>] [--app-id &lt;uuid>]`
 *
 * Spec D2 (#599) — single-command CLI composition over Spec D1's atomic
 * `TaskRequest({ appId, invitedAgentIds, initialConversation })` plus an
 * optional `MessagesSend`. Today's two-step workflow
 * (`conversations create` -> `send conv:&lt;id> &lt;text>`) collapses into
 * one subcommand for the common case.
 *
 * See also:
 *   - `packages/protocol/src/task/tasks.ts -> TaskRequest` / `DEFAULT_APP_ID` /
 *     `AppId` — D1 (#598) wire surface this command composes.
 *   - `packages/client/docs/architecture/moltzap-start-cli.md` for the
 *     command flow diagram, exit-code contract, and test alignment.
 *   - `packages/client/src/cli/commands/conversations.ts -> createConversation`
 *     for the legacy two-step DM/Group create path D2 replaces. Untouched
 *     in D2; D3 (#600) deletes it.
 *   - `packages/client/src/cli/socket-client.ts -> resolveParticipant` —
 *     NOT reused by D2 because that helper goes via the daemon
 *     socket (`socket-client.ts -> request`), bypassing the CLI
 *     `Transport` service that `start.ts` uses for `TaskRequest` /
 *     `MessagesSend`. Mixing the two would make `--as`-mode name lookups
 *     hit the daemon (potentially absent) and would not be testable
 *     via `makeFakeTransport`. D2 introduces a local `resolveAgentTokens`
 *     helper that goes through `transport.ts -> rpc` instead
 *     (see per-flow doc §6 + §"Why we don't reuse `resolveParticipant`").
 */
import { Args, Command, Options } from "@effect/cli";
import { Data, Effect, Either, Option } from "effect";
import {
  AgentsLookupByName,
  DEFAULT_APP_ID,
  MessagesSend,
  TaskConversationList,
  TaskList,
  TaskRequest,
  type AgentId,
  type AppId,
  type Conversation,
  type Task,
  type TaskConversationListItem,
  type TaskId,
} from "@moltzap/protocol";
import type { ConversationId } from "@moltzap/protocol/task";
import { rpc, type Transport, type TransportError } from "../transport.js";

// ─── Exit-code contract (spec D2 Goal 5 + Goal 7) ─────────────────────────

/**
 * Exit-code table for the `moltzap start` command. Values are documented
 * in `Command.withDescription` help text below; the handler branches on
 * these via `runStartCommand` and inline `process.exit` in the
 * partial-success path.
 */
const EXIT_CODES = {
  SUCCESS: 0,
  TASK_CREATE_FAILED: 1,
  PARTIAL_SUCCESS: 2,
  USAGE_ERROR: 64,
} as const;

// ─── Tagged errors (CLI-local) ────────────────────────────────────────────

/**
 * `--app-id &lt;value>` failed syntactic UUID v4 validation before any RPC.
 * Maps to `EXIT_CODES.USAGE_ERROR`; stderr prints
 * `Invalid --app-id: not a UUID`. Local to this module — tests assert
 * by exit code + stderr text rather than `expect().toBeInstanceOf(...)`,
 * so the class stays unexported per the architect plan.
 */
class InvalidAppIdError extends Data.TaggedError("InvalidAppIdError")<{
  readonly value: string;
}> {}

/**
 * An `agent:&lt;name>` or `agent:&lt;uuid>` participant token could not be
 * resolved (name not in the agent roster, or token mis-shaped). Maps
 * to `EXIT_CODES.USAGE_ERROR`; stderr names the unresolved token.
 *
 * Resolver calls `AgentsLookupByName` (a server RPC) for name-shaped
 * tokens. That RPC is read-only and does not mutate server state, so
 * the partial-failure invariant is unaffected. The spec D2 AC clause
 * "NO RPC calls" reads as "NO mutating (TaskRequest / MessagesSend)
 * calls" in this plan; see per-flow doc §8 + plan §R5.
 */
class UnresolvedParticipantError extends Data.TaggedError(
  "UnresolvedParticipantError",
)<{
  readonly token: string;
  readonly reason: "shape" | "not-found";
}> {}

/**
 * Too many DISTINCT name-shaped tokens to batch into one
 * `AgentsLookupByName` RPC (schema caps `names` at `maxItems: 100`).
 * Maps to `EXIT_CODES.USAGE_ERROR`; stderr names the offending count.
 *
 * Distinct from `UnresolvedParticipantError` — fires BEFORE any RPC, on
 * a count check. Without this carve-out, 101+ unique names would
 * trigger an opaque AJV decode failure mapped to exit 1 ("Failed:
 * params decode error"); this surfaces it as a usage error instead.
 */
class TooManyParticipantNamesError extends Data.TaggedError(
  "TooManyParticipantNamesError",
)<{
  readonly count: number;
  readonly max: number;
}> {}

/**
 * Cap pinned to `AgentsLookupByName.params.names: Type.Array(...,
 * { maxItems: 100 })`. Drift here vs. the schema causes a confusing
 * exit-1 AJV rejection instead of the exit-64 usage error.
 */
const MAX_NAME_LOOKUP_BATCH = 100;

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Parsed CLI arguments for the `start` command. `@effect/cli`'s
 * `Args.repeated` admits zero participants — caller-only tasks are
 * permitted at the wire (Spec D1 per-flow doc 12) but not exercised by
 * spec D2 ACs (which cover `length === 1` DM and `length >= 2` group
 * shapes). Handler MUST NOT reject empty `participants`.
 */
export interface StartCommandArgs {
  readonly name: string;
  readonly participants: readonly string[];
  readonly message: string | undefined;
  readonly appId: string | undefined;
}

/**
 * Exhaustive error union for the start-command handler. The wrapping
 * `runStartCommand` adapter converts each tag to an exit code:
 *
 *   `InvalidAppIdError`             -> 64 (usage)
 *   `UnresolvedParticipantError`    -> 64 (usage)
 *   `TooManyParticipantNamesError`  -> 64 (usage; >100 distinct names)
 *   any other `TransportError`      -> 1  (rpc; from `TaskRequest`)
 *
 * The post-`TaskRequest` `MessagesSend` failure path exits 2 via inline
 * `process.exit` inside the handler body, NOT through `runStartCommand`
 * (see per-flow doc §"Partial-failure dispatcher").
 *
 * `TransportError` here is the union from `transport.ts -> TransportError`
 * which includes `TransportDecodeError`, `TransportRpcError`,
 * `ServiceUnreachableError`, `TransportTimeoutError`, and
 * `TransportConfigError`.
 */
type StartCommandError =
  | TransportError
  | InvalidAppIdError
  | UnresolvedParticipantError
  | TooManyParticipantNamesError;

// ─── UUID validation ──────────────────────────────────────────────────────

/**
 * RFC 4122 UUID v4 regex per plan Invariant 7. The `4` in the third
 * group pins the version; the `[89ab]` in the fourth group pins the
 * variant. Pre-existing `socket-client.ts -> UUID_RE` accepts any UUID
 * version, which would let v3/v5/v7 tokens through; spec D2 Goal 7
 * requires v4-specific rejection at exit 64.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateAppId = (
  value: string,
): Effect.Effect<AppId, InvalidAppIdError> =>
  UUID_V4_RE.test(value)
    ? Effect.succeed(value as AppId)
    : Effect.fail(new InvalidAppIdError({ value }));

// ─── Participant token resolver ───────────────────────────────────────────

const AGENT_TOKEN_PREFIX = "agent:";

/**
 * Per-token classification result. Shape failures fail-fast at classify
 * time; UUID-shaped tokens short-circuit client-side; name-shaped tokens
 * are deferred to a SINGLE batched `AgentsLookupByName` RPC.
 */
type Classified =
  | { readonly kind: "uuid"; readonly id: AgentId }
  | { readonly kind: "name"; readonly token: string; readonly name: string };

const classifyToken = (
  token: string,
): Effect.Effect<Classified, UnresolvedParticipantError> => {
  const failShape = Effect.fail(
    new UnresolvedParticipantError({ token, reason: "shape" }),
  );
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return failShape;
  const rest = token.slice(AGENT_TOKEN_PREFIX.length);
  if (rest.length === 0) return failShape;
  if (UUID_V4_RE.test(rest)) {
    return Effect.succeed({ kind: "uuid", id: rest as AgentId } as const);
  }
  return Effect.succeed({ kind: "name", token, name: rest } as const);
};

/**
 * Resolve all participant tokens to bare `AgentId`s matching
 * `TaskRequest.params.invitedAgentIds: Array(AgentId)` directly (no
 * `.map(p => p.id)` step needed).
 *
 * Failure modes (first in input order wins):
 *   - Token does not start with `agent:` (or is `agent:` with empty
 *     name) -> `UnresolvedParticipantError({ reason: "shape" })`.
 *   - Token is `agent:&lt;name>` and the batched lookup returns no agent
 *     matching `name` -> `UnresolvedParticipantError({ reason:
 *     "not-found" })`.
 *
 * WHY one batched RPC instead of one-per-token: `AgentsLookupByName`
 * accepts `names: Array(..., { minItems: 1, maxItems: 100 })`. Coalesce
 * unique name-shaped tokens into a single RPC; UUID-shaped tokens skip
 * the wire entirely. Resolution map keys on agent name so duplicate
 * tokens (`agent:bob agent:bob`) resolve to the same id without
 * re-asking the server.
 *
 * Architect plan §R1 explains why this is a local helper rather than
 * reusing `socket-client.ts -> resolveParticipant` (transport mismatch,
 * testability, wire-shape match).
 */
const uniqueNamesOf = (classified: readonly Classified[]): readonly string[] =>
  Array.from(
    new Set(classified.flatMap((c) => (c.kind === "name" ? [c.name] : []))),
  );

/**
 * Look up `names` in one batched RPC (no-op when empty) and return a
 * name→AgentId map keyed by FIRST agent per name. The server's response
 * is a flat agents array; mapping by name preserves the pre-P3-2
 * tie-break ("first agent wins"). Caps at `MAX_NAME_LOOKUP_BATCH`
 * BEFORE the RPC to keep the >100 case as a usage error rather than a
 * decode failure.
 */
const lookupAgentIdsByName = (
  names: readonly string[],
): Effect.Effect<
  ReadonlyMap<string, AgentId>,
  TransportError | TooManyParticipantNamesError,
  Transport
> =>
  Effect.gen(function* () {
    const byName = new Map<string, AgentId>();
    if (names.length === 0) return byName;
    if (names.length > MAX_NAME_LOOKUP_BATCH) {
      return yield* Effect.fail(
        new TooManyParticipantNamesError({
          count: names.length,
          max: MAX_NAME_LOOKUP_BATCH,
        }),
      );
    }
    // Defensive copy: AgentsLookupByName.params.names resolves to
    // mutable `string[]` (TypeBox's `Static<Array>`); pass a shallow
    // clone so the caller's readonly contract isn't bypassed.
    const result = yield* rpc(AgentsLookupByName, { names: [...names] });
    for (const agent of result.agents) {
      if (!byName.has(agent.name)) byName.set(agent.name, agent.id);
    }
    return byName;
  });

const resolveAgentTokens = (
  tokens: readonly string[],
): Effect.Effect<
  readonly AgentId[],
  UnresolvedParticipantError | TooManyParticipantNamesError | TransportError,
  Transport
> =>
  Effect.gen(function* () {
    const classified = yield* Effect.all(tokens.map(classifyToken));
    const agentIdByName = yield* lookupAgentIdsByName(
      uniqueNamesOf(classified),
    );
    // Single for-loop avoids a second `Effect.all` over pure post-batch
    // resolution (N extra Effect cells); fail-fast on first miss preserves
    // input-order error semantics.
    const resolved: AgentId[] = [];
    for (const entry of classified) {
      if (entry.kind === "uuid") {
        resolved.push(entry.id);
        continue;
      }
      const id = agentIdByName.get(entry.name);
      if (id === undefined) {
        return yield* Effect.fail(
          new UnresolvedParticipantError({
            token: entry.token,
            reason: "not-found",
          }),
        );
      }
      resolved.push(id);
    }
    return resolved;
  });

// ─── Handler stages ───────────────────────────────────────────────────────

const resolveAppId = (
  raw: string | undefined,
): Effect.Effect<AppId, InvalidAppIdError> =>
  raw === undefined ? Effect.succeed(DEFAULT_APP_ID) : validateAppId(raw);

const printTaskCreated = (
  task: Task,
  conversation: Conversation,
): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(`Task started: ${task.id} (conversation: ${conversation.id})`);
  });

const printTaskReused = (
  taskId: TaskId,
  conversation: Conversation,
): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(
      `Task started: ${taskId} (reusing existing conversation: ${conversation.id})`,
    );
  });

const printMessageSent = (messageId: string): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(`Message sent: ${messageId}`);
  });

const sendFirstMessage = (
  taskId: TaskId,
  conversationId: ConversationId,
  text: string,
): Effect.Effect<void, never, Transport> =>
  Effect.either(
    rpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text }],
    }),
  ).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (err) =>
          Effect.sync(() => {
            console.error(`Error sending message: ${err.message}`);
            process.exit(EXIT_CODES.PARTIAL_SUCCESS);
          }),
        onRight: (ok) => printMessageSent(ok.message.id),
      }),
    ),
  );

const createTaskAtomic = (
  appId: AppId,
  invitedAgentIds: readonly AgentId[],
  name: string,
): Effect.Effect<
  { readonly task: Task; readonly conversation: Conversation },
  TransportError,
  Transport
> =>
  Effect.gen(function* () {
    // Defensive copies: TaskRequest's params type expects mutable arrays
    // (TypeBox's Static<Array> resolves to T[], not readonly T[]); pass
    // shallow clones so the caller's readonly contract isn't bypassed.
    //
    // Spec D2 (#599) amendment N7 (zero-participant carve-out):
    // `InitialConversationSchema.participants` is `Type.Optional(Type.Array(AgentId,
    // { minItems: 1 }))` — an EMPTY array fails server AJV. The
    // caller-only path (help text + plan §R4 + `start.test.ts →
    // zeroParticipants`) MUST omit `participants` entirely; the server
    // adds the caller to `conversation_participants` implicitly. See
    // `packages/protocol/src/task/tasks.ts → InitialConversationSchema`.
    const initialConversation =
      invitedAgentIds.length === 0
        ? { name }
        : { name, participants: [...invitedAgentIds] };
    const result = yield* rpc(TaskRequest, {
      appId,
      invitedAgentIds: [...invitedAgentIds],
      initialConversation,
    });
    if (result.conversation === null) {
      // `start` always supplies `initialConversation`, and the D3 server
      // mints + returns that conversation on accept (it only returns
      // `conversation: null` when no `initialConversation` was sent). A null
      // here is therefore a server-contract violation, not a normal outcome —
      // surface it loudly rather than print a bogus conversation id.
      return yield* Effect.dieMessage(
        "task/request returned a null conversation despite an initialConversation request",
      );
    }
    return { task: result.task, conversation: result.conversation };
  });

// ─── Proactive "one DM per pair" dedup (issue #685) ───────────────────────
//
// Server-side `DEFAULT_APP_ID` dedup was retired in #677; the "one DM per
// pair" UX now lives here. Before creating a task we look for an existing live
// conversation under this `appId` whose task participant set is exactly the
// requested pair/group, and reuse it instead of minting a duplicate.

/**
 * Page-count cap on the conversation-list scan. Conversations are returned
 * activity-desc, so a recently-touched match sits near the top; the cap bounds
 * work on pathological long lists. A miss degrades to creating a fresh task —
 * never to incorrectness — so a conservative window is safe.
 */
const DEDUP_SCAN_PAGE_SIZE = 100;
const DEDUP_SCAN_MAX_PAGES = 10;

/**
 * `task/list` returns at most `limit` (≤ 200) tasks and no continuation
 * cursor, so the app-scoping window is a single page of the caller's most
 * recent tasks. Adequate for dedup: a pair you're actively messaging is recent.
 */
const TASK_LIST_SCAN_LIMIT = 200;

/**
 * Whether a task's participant set is exactly `{caller} ∪ invited`. The
 * caller is implicitly a participant of every task the caller-scoped list
 * returns, so the match is `invited ⊆ participants` and
 * `|participants| === |unique(invited)| + 1` — no need for the client to know
 * its own agent id. A degenerate self-invite (caller ∈ invited) simply fails to
 * match and falls through to create, which is acceptable.
 */
const participantSetMatchesInvited = (
  participants: readonly AgentId[],
  invited: readonly AgentId[],
): boolean => {
  const uniqueInvited = new Set(invited);
  if (participants.length !== uniqueInvited.size + 1) return false;
  const present = new Set(participants);
  for (const id of uniqueInvited) {
    if (!present.has(id)) return false;
  }
  return true;
};

/**
 * First non-archived, in-app-scope conversation in `items` whose task
 * participant set matches `{caller} ∪ invited`, or `null`. Pulled out of
 * {@link findReusableDmConversation} to keep that generator's complexity low.
 */
const conversationListParams = (
  cursor: string | undefined,
): { limit: number; cursor?: string } =>
  cursor === undefined
    ? { limit: DEDUP_SCAN_PAGE_SIZE }
    : { limit: DEDUP_SCAN_PAGE_SIZE, cursor };

const pickReusableFromPage = (
  items: ReadonlyArray<TaskConversationListItem>,
  appTaskIds: ReadonlySet<TaskId>,
  invited: readonly AgentId[],
): { readonly taskId: TaskId; readonly conversation: Conversation } | null => {
  for (const item of items) {
    if (
      appTaskIds.has(item.taskId) &&
      item.conversation.archivedAt === undefined &&
      participantSetMatchesInvited(item.participants, invited)
    ) {
      return { taskId: item.taskId, conversation: item.conversation };
    }
  }
  return null;
};

/**
 * Caller's ACTIVE task ids under `appId`. `TaskConversationListItem` carries
 * no `appId`, so we scope the dedup to the requested app via `task/list` and
 * intersect by `taskId` in {@link findReusableDmConversation}. Only `active`
 * tasks are reuse targets (a `closed`/`failed` task's conversations are dead).
 */
const collectActiveTaskIdsForApp = (
  appId: AppId,
): Effect.Effect<ReadonlySet<TaskId>, TransportError, Transport> =>
  rpc(TaskList, { limit: TASK_LIST_SCAN_LIMIT }).pipe(
    Effect.map(
      ({ tasks }) =>
        new Set(
          tasks
            .filter((task) => task.appId === appId && task.status === "active")
            .map((task) => task.id),
        ),
    ),
  );

/**
 * Locate a reusable conversation for `{caller} ∪ invited` under `appId`, or
 * `null` if none. Zero-participant (solo) `start`s are carved out — they never
 * dedup (mirrors Spec D2 amendment N7). Tie-break: first match in the
 * activity-desc list order (most-recently-active). The conversation must be
 * non-archived; archived rows are surfaced unfiltered by `TaskConversationList`
 * and filtered locally (`archivedAt === undefined`).
 */
const findReusableDmConversation = (
  appId: AppId,
  invited: readonly AgentId[],
): Effect.Effect<
  { readonly taskId: TaskId; readonly conversation: Conversation } | null,
  TransportError,
  Transport
> =>
  Effect.gen(function* () {
    if (invited.length === 0) return null;
    const appTaskIds = yield* collectActiveTaskIdsForApp(appId);
    if (appTaskIds.size === 0) return null;
    let cursor: string | undefined = undefined;
    for (let page = 0; page < DEDUP_SCAN_MAX_PAGES; page++) {
      const params: { limit: number; cursor?: string } =
        conversationListParams(cursor);
      const result = yield* rpc(TaskConversationList, params);
      const hit = pickReusableFromPage(result.items, appTaskIds, invited);
      if (hit !== null) return hit;
      if (result.nextCursor === undefined) return null;
      cursor = result.nextCursor;
    }
    return null;
  });

// ─── Handler body ─────────────────────────────────────────────────────────

/**
 * `moltzap start` handler. Four stages (see per-flow doc 09 §6):
 *
 *   1. Validate `args.appId` UUID v4 if set; else use `DEFAULT_APP_ID`.
 *      Failure -> `InvalidAppIdError` -> exit 64 via `runStartCommand`.
 *   2. Resolve `args.participants` via `resolveAgentTokens` (single
 *      batched `AgentsLookupByName` RPC for name-shaped tokens;
 *      UUID-shaped tokens short-circuit). Any token failure ->
 *      `UnresolvedParticipantError` -> exit 64.
 *   3. Proactive "one DM per pair" dedup (#685): scan the caller's active
 *      tasks under `appId` (`task/list`) + their conversations
 *      (`task/conversation/list`) for a non-archived conversation whose task
 *      participant set is exactly `{caller} ∪ invitedAgentIds`. If found,
 *      reuse it — print `Task started: &lt;taskId> (reusing existing
 *      conversation: &lt;convId>)` — and skip task creation. Solo
 *      (zero-participant) `start`s never dedup. The scan is best-effort: a
 *      transient list failure falls through to create rather than aborting.
 *   4. Otherwise `rpc(TaskRequest, { appId, invitedAgentIds,
 *      initialConversation })` where `initialConversation` carries
 *      `participants` ONLY when `invitedAgentIds.length > 0` (P2-B). On
 *      success print `Task started: &lt;taskId> (conversation: &lt;convId>)`.
 *      `TaskRequest` wire failure -> `TransportError` -> exit 1 via
 *      `runStartCommand`, no stdout.
 *   5. If `args.message` is set AND a conversation was produced (reuse or
 *      create), call `rpc(MessagesSend, ...)` wrapped in `Effect.either`.
 *      Success -> print `Message sent: &lt;msgId>`, exit 0. Failure -> print
 *      `Error sending message: &lt;err>` to stderr, exit 2 via inline
 *      `process.exit` (preserves the already-printed stdout line; cannot
 *      route through `runStartCommand`).
 */
const startCommandHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, StartCommandError, Transport> =>
  Effect.gen(function* () {
    const appId = yield* resolveAppId(args.appId);
    const invitedAgentIds = yield* resolveAgentTokens(args.participants);
    const messageOpt = Option.fromNullable(args.message);

    // Best-effort dedup: a transient list-scan failure must not block creating
    // the task, so swallow scan errors and fall through to create.
    const reuse = yield* findReusableDmConversation(
      appId,
      invitedAgentIds,
    ).pipe(Effect.orElseSucceed(() => null));
    if (reuse !== null) {
      yield* printTaskReused(reuse.taskId, reuse.conversation);
      yield* Option.match(messageOpt, {
        onNone: () => Effect.void,
        onSome: (m) => sendFirstMessage(reuse.taskId, reuse.conversation.id, m),
      });
      return;
    }

    const { task, conversation } = yield* createTaskAtomic(
      appId,
      invitedAgentIds,
      args.name,
    );
    yield* printTaskCreated(task, conversation);
    yield* Option.match(messageOpt, {
      onNone: () => Effect.void,
      onSome: (m) => sendFirstMessage(task.id, conversation.id, m),
    });
  }).pipe(Effect.withSpan("startCommandHandler"));

// ─── Exit-code dispatcher ─────────────────────────────────────────────────

/**
 * Outer adapter that replaces the shared `transport.ts -> runHandler`
 * (which collapses every error to exit 1) with a `_tag`-aware mapping
 * per the spec D2 exit-code contract:
 *
 *   `InvalidAppIdError`             -> 64 + stderr `Invalid --app-id: not a UUID`
 *   `UnresolvedParticipantError`    -> 64 + stderr `Cannot resolve "&lt;token>": &lt;reason>`
 *   `TooManyParticipantNamesError`  -> 64 + stderr `Too many distinct agent names: &lt;count> (max &lt;max>)`
 *   any other `StartCommandError`   -> 1  + stderr `Failed: &lt;err.message>`
 *
 * The exit-2 partial-success branch runs inline inside
 * `startCommandHandler` (after `Task started:` has been printed to
 * stdout) and never reaches this adapter — re-throwing the post-
 * `TaskRequest` error here would discard the already-printed stdout
 * line.
 */
const runStartCommand = (
  effect: Effect.Effect<void, StartCommandError, Transport>,
): Effect.Effect<void, never, Transport> =>
  effect.pipe(
    Effect.catchTag("InvalidAppIdError", () =>
      Effect.sync(() => {
        console.error("Invalid --app-id: not a UUID");
        process.exit(EXIT_CODES.USAGE_ERROR);
      }),
    ),
    Effect.catchTag("UnresolvedParticipantError", (err) =>
      Effect.sync(() => {
        console.error(`Cannot resolve "${err.token}": ${err.reason}`);
        process.exit(EXIT_CODES.USAGE_ERROR);
      }),
    ),
    Effect.catchTag("TooManyParticipantNamesError", (err) =>
      Effect.sync(() => {
        console.error(
          `Too many distinct agent names: ${err.count} (max ${err.max})`,
        );
        process.exit(EXIT_CODES.USAGE_ERROR);
      }),
    ),
    Effect.catchAll((err) =>
      Effect.sync(() => {
        // `Data.TaggedError` populates `message` for every tagged-error
        // subclass; `|| err._tag` is a belt-and-suspenders fallback for
        // the (impossible-per-Data-contract) empty-message case.
        const msg = err.message || err._tag;
        console.error(`Failed: ${msg}`);
        process.exit(EXIT_CODES.TASK_CREATE_FAILED);
      }),
    ),
  );

// ─── @effect/cli wiring ───────────────────────────────────────────────────

const nameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Conversation name"),
);

const participantsArg = Args.text({ name: "participant" }).pipe(
  Args.withDescription(
    "Participant token (e.g. agent:bob or agent:<uuid>). " +
      "Zero or more allowed; D2 ACs cover 1 (DM-shape) and >=2 (group-shape).",
  ),
  Args.repeated,
);

const messageOption = Options.text("message").pipe(
  Options.withDescription(
    "First message body. If supplied, MessagesSend runs after the atomic " +
      "TaskRequest (separate RPC, not server-atomic).",
  ),
  Options.optional,
);

const appIdOption = Options.text("app-id").pipe(
  Options.withDescription(
    "App UUID v4. Defaults to DEFAULT_APP_ID (D1 #635). Invalid syntax " +
      "exits 64 with NO RPC calls (Goal 7).",
  ),
  Options.optional,
);

/**
 * Test seam: invoke the handler directly with parsed args, bypassing
 * `@effect/cli`'s parser. Returns the same `Effect` the `Command.make`
 * wrapper would produce, including the `runStartCommand` exit-code
 * dispatcher. Tests `Effect.provideService(Transport, fake)` and assert
 * `process.exit` was called with the expected code.
 */
export const runStartHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, never, Transport> =>
  runStartCommand(startCommandHandler(args));

export const startCommand = Command.make(
  "start",
  {
    name: nameArg,
    participants: participantsArg,
    message: messageOption,
    appId: appIdOption,
  },
  ({ name, participants, message, appId }) =>
    runStartHandler({
      name,
      participants,
      message: Option.getOrUndefined(message),
      appId: Option.getOrUndefined(appId),
    }),
).pipe(
  Command.withDescription(
    "Start a task with named participants and (optionally) send the " +
      "first message in one atomic step. Spec D2 #599 — composes Spec D1 " +
      "TaskRequest + MessagesSend.\n" +
      "\n" +
      "Zero participants creates a caller-only task (rare; usually you " +
      "will pass one or more `agent:<name>` tokens).\n" +
      "\n" +
      "Exit codes:\n" +
      `  ${EXIT_CODES.SUCCESS}   success (TaskRequest + optional MessagesSend resolved)\n` +
      `  ${EXIT_CODES.TASK_CREATE_FAILED}   TaskRequest failed (stdout empty)\n` +
      `  ${EXIT_CODES.PARTIAL_SUCCESS}   TaskRequest OK, MessagesSend failed (no rollback)\n` +
      `  ${EXIT_CODES.USAGE_ERROR}  usage error (bad --app-id UUID, unresolvable agent token, or >${MAX_NAME_LOOKUP_BATCH} distinct name-shaped tokens)`,
  ),
);
