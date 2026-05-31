/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */

/**
 * `moltzap start &lt;name> &lt;participant>... [--message &lt;text>] [--app-id &lt;uuid>]`
 *
 * Single-command composition over the protocol's atomic
 * `TaskRequest({ appId, invitedAgentIds, initialConversation })` plus
 * an optional follow-up `MessagesSend`. DM-vs-Group is implicit from
 * participant count.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant shell
 *   participant cli as effect-cli
 *   participant start as startCommandHandler
 *   participant tx as transport.rpc
 *
 *   shell->>cli: moltzap start &lt;name> agent:bob ... [--message] [--app-id]
 *   cli->>start: StartCommandArgs
 *   Note over start: 1. validateAppId — bad UUID → exit 64
 *   Note over start: 2. resolveAgentTokens — classify each token<br>UUID short-circuits, names batch into ONE AgentsLookupByName call
 *   start->>tx: rpc(AgentsLookupByName, {names})
 *   tx-->>start: {agents}
 *   Note over start: unresolved → exit 64
 *   start->>tx: rpc(TaskRequest, {appId, invitedAgentIds, initialConversation})
 *   tx-->>start: {task, conversation | null}
 *   alt conversation present (fresh create)
 *     Note over start: stdout — Task started — taskId — convId
 *   else conversation null (dedup hit)
 *     start->>tx: rpc(TaskConversationList) — follow nextCursor
 *     tx-->>start: items
 *     Note over start: findReusableConversation — first non-archived under existing taskId
 *     alt found
 *       Note over start: stdout — Task started — reusing existing conversation
 *     else none usable
 *       Note over start: stderr — task closed — exit 1
 *     end
 *   end
 *   opt --message
 *     start->>tx: rpc(MessagesSend, {conversationId, parts})
 *     alt success
 *       Note over start: stdout — Message sent — exit 0
 *     else failure
 *       Note over start: stderr — Error sending message — exit 2
 *     end
 *   end
 * ```
 *
 * **Exit-code contract** — keyed on the stage where the error arose:
 *
 * | Code | Meaning                                                      | Stdout                                  | Stderr                                 |
 * |------|--------------------------------------------------------------|-----------------------------------------|----------------------------------------|
 * |  0   | Full success (fresh create or dedup reuse)                   | `Task started: ...` (+ `Message sent`)  | empty                                  |
 * |  1   | `TaskRequest` wire failure OR dedup hit on closed/unreachable | empty                                   | `Failed: ...` / `Task already exists`  |
 * |  2   | `TaskRequest` OK, `MessagesSend` failed                       | `Task started: ...`                     | `Error sending message: ...`           |
 * |  64  | Usage error: bad `--app-id` UUID, unresolvable agent token, OR more than 100 distinct name tokens | empty | `Invalid --app-id` / `Cannot resolve "..."` |
 *
 * Exit 64 matches POSIX `EX_USAGE`. NO rollback on exit 2 — the task
 * + empty conversation persist; the user can retry
 * `moltzap send conv:&lt;id> &lt;text>`.
 *
 * The exit-code partition is split:
 *
 * - `runStartCommand` (outer `Effect.catchAll`) pattern-matches
 *   `StartCommandError` `_tag` and dispatches to 1 or 64.
 * - Inline `process.exit(2)` lives in the handler body for the
 *   post-`TaskRequest` `MessagesSend` failure. This path cannot route
 *   through `runStartCommand` because the stdout `Task started: ...`
 *   line has already been printed; re-throwing would discard it from
 *   the user's view. The handler uses
 *   `Effect.either(rpc(MessagesSend, ...))` + `Effect.sync(() => { ...
 *   process.exit(2) })`.
 *
 * **Dedup branch** — when `appId === DEFAULT_APP_ID` and the caller
 * already owns a task with the exact same `{caller} ∪ invitedAgentIds`
 * set, the server returns `{ task, conversation: null }`.
 * `handleDedupOutcome` calls `TaskConversationList` (with cursor
 * follow capped at `DEDUP_LOOKUP_MAX_PAGES`) and runs
 * `findReusableConversation` to find a non-archived conversation
 * under the existing task. Found → reuse stdout line; not found →
 * closed-task diagnostic + exit 1.
 *
 * **Zero-participant carve-out** — when `invitedAgentIds === []`, the
 * caller-only task path MUST omit `participants` from
 * `initialConversation` entirely because
 * `InitialConversationSchema.participants` rejects `[]`. The server
 * adds the caller to both `task_participants` and
 * `conversation_participants` implicitly.
 *
 * **Why this doesn't reuse `socket-client.ts → resolveParticipant`** —
 * that helper hard-wires the daemon-socket path
 * (`socket-client.ts → request`), bypassing the CLI `Transport`
 * service that `start.ts` uses for `TaskRequest` / `MessagesSend`.
 * Mixing the two would make `--as`-mode name lookups hit the daemon
 * (potentially absent) and would not be testable via
 * `makeFakeTransport`. The local `resolveAgentTokens` goes through
 * `transport.ts → rpc` instead and coalesces all name-shaped tokens
 * into ONE batched `AgentsLookupByName` call.
 *
 * Sibling: `packages/protocol/src/task/tasks.ts → TaskRequest` /
 * `DEFAULT_APP_ID` / `AppId` — the wire surface this command composes.
 */
import { Args, Command, Options } from "@effect/cli";
import { Data, Effect, Either, Option } from "effect";
import {
  AgentsLookupByName,
  DEFAULT_APP_ID,
  MessagesSend,
  TaskConversationList,
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

// ─── Exit-code contract ───────────────────────────────────────────────────

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
 * so the class stays unexported.
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
 * resolving participants before validation does not affect the
 * partial-failure invariant: only `TaskRequest` / `MessagesSend` mutate.
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
 * permitted at the wire (`length === 1` is a DM, `length >= 2` a group).
 * Handler MUST NOT reject empty `participants`.
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
 * `process.exit` inside the handler body, NOT through `runStartCommand`.
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
 * RFC 4122 UUID v4 regex. The `4` in the third group pins the version;
 * the `[89ab]` in the fourth group pins the variant. `socket-client.ts ->
 * UUID_RE` accepts any UUID version, which would let v3/v5/v7 tokens
 * through; `--app-id` requires v4-specific rejection at exit 64.
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
 * is a flat agents array; mapping by name applies a "first agent wins"
 * tie-break. Caps at `MAX_NAME_LOOKUP_BATCH` BEFORE the RPC to keep the
 * >100 case as a usage error rather than a decode failure.
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
    // `AgentsLookupByName.params.names` is `Schema.Array` → `ReadonlyArray`,
    // so the `readonly string[]` param passes through as-is.
    const result = yield* rpc(AgentsLookupByName, { names });
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
  task: Task,
  conversation: Conversation,
): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(
      `Task started: ${task.id} (reusing existing conversation: ${conversation.id})`,
    );
  });

const printTaskAlreadyClosed = (taskId: TaskId): Effect.Effect<void> =>
  Effect.sync(() => {
    // WHY this single message covers two distinct conditions:
    // (a) the existing task has no non-archived conversation, OR
    // (b) the dedup-lookup window (1000 rows) did not surface one.
    // (b) is rare per the activity-desc server ordering; if a heavy
    // user trips it on an active task, this diagnostic is intentionally
    // conservative ("closed") rather than claiming false freshness. The
    // follow-up `moltzap conversations list` invocation surfaces the real
    // state.
    console.error(`Task already exists but is closed: ${taskId}`);
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

/**
 * Outcome of the atomic `TaskRequest` call. The dedup branch fires when
 * `appId === DEFAULT_APP_ID` AND the caller already owns a task with
 * the exact same `{caller} ∪ invitedAgentIds` participant set (see
 * `packages/server/src/task/services/task.service.ts → TaskService.findExistingTaskByParticipants`).
 * The server returns `{ task: existing, conversation: null }` even when
 * `initialConversation` was supplied — dedup is task-level, not
 * conversation-level — so the CLI MUST treat `conversation === null`
 * as a legitimate outcome rather than a decode error.
 */
type CreateTaskOutcome =
  | {
      readonly kind: "created";
      readonly task: Task;
      readonly conversation: Conversation;
    }
  | { readonly kind: "dedup"; readonly task: Task };

const createTaskAtomic = (
  appId: AppId,
  invitedAgentIds: readonly AgentId[],
  name: string,
): Effect.Effect<CreateTaskOutcome, TransportError, Transport> =>
  Effect.gen(function* () {
    // Zero-participant carve-out: `InitialConversationSchema.participants`
    // is `Schema.optional(Schema.Array(AgentId).pipe(Schema.minItems(1)))`
    // — an EMPTY array fails the server's decode. The caller-only path MUST
    // omit `participants` entirely; the server adds the caller to
    // `conversation_participants` implicitly.
    // See `packages/protocol/src/task/tasks.ts → InitialConversationSchema`.
    const initialConversation =
      invitedAgentIds.length === 0
        ? { name }
        : { name, participants: invitedAgentIds };
    const result = yield* rpc(TaskRequest, {
      appId,
      invitedAgentIds,
      initialConversation,
    });
    if (result.conversation === null) {
      // Dedup hit (per `tasks.handlers.ts → maybeTaskCreateDedup`): the
      // server matched an existing task by `{caller} ∪ invitedAgentIds`
      // and returned it with `conversation: null`. Handler resolves a
      // reusable conversation via `findReusableConversation` instead of
      // failing.
      return { kind: "dedup", task: result.task } as const;
    }
    return {
      kind: "created",
      task: result.task,
      conversation: result.conversation,
    } as const;
  });

// ─── Dedup-hit conversation lookup ────────────────────────────────────────

/**
 * Page size + safety cap on `TaskConversationList` follow-up calls. The
 * dedup-hit conversation should appear in the first page for any
 * recently-touched task (server orders by activity desc, see
 * `packages/server/src/task/services/conversation-list-pagination.ts →
 * queryConversationListRows`). The cap protects against pathological
 * cases where the caller has a very long list and the target task is
 * older than the window can see — in which case we surface the closed-
 * task diagnostic rather than spin indefinitely.
 */
const DEDUP_LOOKUP_PAGE_SIZE = 100;
const DEDUP_LOOKUP_MAX_PAGES = 10;

/**
 * Filter rule for the dedup-hit lookup: (a) the item's `taskId` must
 * match the existing task we are reusing (the list is caller-scoped
 * across ALL of the caller's tasks, not task-scoped); (b) the
 * conversation must be non-archived (server includes archived rows
 * unfiltered per `TaskConversationList`'s contract — clients filter
 * `archivedAt !== undefined` locally; archived strings are absent
 * on the wire when the row is active, never `null`, per
 * `ConversationSchema.archivedAt: Type.Optional(DateTimeString)`).
 */
const pickReusableFromPage = (
  items: ReadonlyArray<TaskConversationListItem>,
  taskId: TaskId,
): Conversation | null => {
  const match = items.find(
    (item) =>
      item.taskId === taskId && item.conversation.archivedAt === undefined,
  );
  return match === undefined ? null : match.conversation;
};

const findReusableConversation = (
  taskId: TaskId,
): Effect.Effect<Conversation | null, TransportError, Transport> =>
  Effect.gen(function* () {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < DEDUP_LOOKUP_MAX_PAGES; page++) {
      const params: { limit: number; cursor?: string } = {
        limit: DEDUP_LOOKUP_PAGE_SIZE,
      };
      if (cursor !== undefined) params.cursor = cursor;
      const result = yield* rpc(TaskConversationList, params);
      const hit = pickReusableFromPage(result.items, taskId);
      if (hit !== null) return hit;
      if (result.nextCursor === undefined) return null;
      cursor = result.nextCursor;
    }
    return null;
  });

/**
 * Dedup-hit branch. `TaskConversationList` wire failures are captured
 * inline via `Effect.either` (same pattern + same reason as
 * `sendFirstMessage`'s partial-success handling) because `TaskRequest`
 * already succeeded server-side; routing the list error through
 * `runStartCommand`'s `catchAll` would print `Failed: &lt;list-error>`,
 * misleading the user into thinking the create failed.
 */
const onReuseFound = (
  task: Task,
  reuse: Conversation,
  message: Option.Option<string>,
): Effect.Effect<void, never, Transport> =>
  Effect.zipRight(
    printTaskReused(task, reuse),
    Option.match(message, {
      onNone: () => Effect.void,
      onSome: (m) => sendFirstMessage(task.id, reuse.id, m),
    }),
  );

const onReuseNull = (task: Task): Effect.Effect<void, never, Transport> =>
  Effect.zipRight(
    printTaskAlreadyClosed(task.id),
    Effect.sync(() => {
      process.exit(EXIT_CODES.TASK_CREATE_FAILED);
    }),
  );

const handleDedupOutcome = (
  task: Task,
  message: Option.Option<string>,
): Effect.Effect<void, never, Transport> =>
  Effect.either(findReusableConversation(task.id)).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (err) =>
          Effect.sync(() => {
            console.error(
              `Task ${task.id} already exists but reusable-conversation lookup failed: ${err.message}`,
            );
            process.exit(EXIT_CODES.TASK_CREATE_FAILED);
          }),
        onRight: (reuse) =>
          reuse === null
            ? onReuseNull(task)
            : onReuseFound(task, reuse, message),
      }),
    ),
  );

// ─── Handler body ─────────────────────────────────────────────────────────

/**
 * `moltzap start` handler. Four stages:
 *
 *   1. Validate `args.appId` UUID v4 if set; else use `DEFAULT_APP_ID`.
 *      Failure -> `InvalidAppIdError` -> exit 64 via `runStartCommand`.
 *   2. Resolve `args.participants` via `resolveAgentTokens` (single
 *      batched `AgentsLookupByName` RPC for name-shaped tokens;
 *      UUID-shaped tokens short-circuit). Any token failure ->
 *      `UnresolvedParticipantError` -> exit 64.
 *   3. `rpc(TaskRequest, { appId, invitedAgentIds, initialConversation })`
 *      where `initialConversation` carries `participants` ONLY when
 *      `invitedAgentIds.length > 0`. Two success outcomes:
 *      - `created`: server returned a fresh `conversation`. Print
 *        `Task started: &lt;taskId> (conversation: &lt;convId>)`.
 *      - `dedup`: server returned `conversation: null` because
 *        `{caller} ∪ invitedAgentIds` already owned a task on this
 *        appId. Auto-fetch the most-recently-active non-
 *        archived conversation under the existing task via
 *        `findReusableConversation` and print
 *        `Task started: &lt;taskId> (reusing existing conversation: &lt;convId>)`.
 *        If no usable conversation exists (closed task, all archived,
 *        or out of dedup-lookup window), print
 *        `Task already exists but is closed: &lt;taskId>` to stderr and
 *        exit 1.
 *      `TaskRequest` wire failure -> `TransportError` -> exit 1 via
 *      `runStartCommand`, no stdout.
 *   4. If `args.message` is set AND a conversation was produced (either
 *      kind), call `rpc(MessagesSend, { conversationId, parts: [{ type:
 *      "text", text }] })` wrapped in `Effect.either`. Success -> print
 *      `Message sent: &lt;msgId>`, exit 0. Failure -> print
 *      `Error sending message: &lt;err>` to stderr, exit 2 via inline
 *      `process.exit` (preserves the already-printed stdout line;
 *      cannot route through `runStartCommand`).
 */
const startCommandHandler = (
  args: StartCommandArgs,
): Effect.Effect<void, StartCommandError, Transport> =>
  Effect.gen(function* () {
    const appId = yield* resolveAppId(args.appId);
    const invitedAgentIds = yield* resolveAgentTokens(args.participants);
    const outcome = yield* createTaskAtomic(appId, invitedAgentIds, args.name);
    const messageOpt = Option.fromNullable(args.message);
    if (outcome.kind === "dedup") {
      yield* handleDedupOutcome(outcome.task, messageOpt);
      return;
    }
    yield* printTaskCreated(outcome.task, outcome.conversation);
    yield* Option.match(messageOpt, {
      onNone: () => Effect.void,
      onSome: (m) =>
        sendFirstMessage(outcome.task.id, outcome.conversation.id, m),
    });
  }).pipe(Effect.withSpan("startCommandHandler"));

// ─── Exit-code dispatcher ─────────────────────────────────────────────────

/**
 * Outer adapter with a `_tag`-aware exit-code mapping. Used instead of
 * the shared `transport.ts -> runHandler` (which collapses every error
 * to exit 1):
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
