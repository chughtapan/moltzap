# 08 — Channel-base subpath

The `@moltzap/client/channel-base` subpath is the shared scaffolding layer for
the three channel adapters (`openclaw-channel`, `claude-code-channel`,
`nanoclaw-channel`). It hosts the canonical `LeaseAlreadyConsumed` tagged
error, the `LeaseStore` / `LeaseGuard` lease lifecycle primitives, and the
markup-parameterized cross-conv + group-block formatters.

Spec: #597. Architect plan: #605. Parent epic: #602.

## 1. Goals

Before this layer existed, the three channels each carried a near-duplicate
copy of:

- The `LeaseAlreadyConsumed` error class (two different field shapes — one
  with only `leaseId`, one as a stringly-reasoned `MoltZapChannelError`).
- A `RpcServerError` → `LeaseAlreadyConsumed` projection helper.
- Lease lifecycle state (openclaw used a `consumedLeaseAt: number | null`
  closure; nanoclaw used a `Map<string, string>`).
- A cross-conversation context formatter (two markup variants).
- A group-metadata formatter (nanoclaw only) plus an ad-hoc narrowing
  predicate (openclaw + nanoclaw inlined the `type === "group"` check).

Channel-base consolidates these into a single subpath. The decisions resolved
during spec iteration:

- **C1 (canonical class).** All three channels canonicalize on the channel-base
  `LeaseAlreadyConsumed`. Surfacing mechanism differs per host contract
  (`server.ts → toolErrorResult` for claude-code; Effect raise for nanoclaw;
  optional `onLeaseConsumed` side-channel for openclaw because deliver's wire
  return type is `PromiseLike<boolean>`).
- **C2 (nanoclaw integ).** Echo + reconnection integration tests only; no
  routing or stress tests at this layer.
- **C3 (subpath).** Lives at `packages/client/src/channel-base/`, not a new
  workspace package.

## 2. Primitives

### `LeaseAlreadyConsumed`

Canonical `TaggedError`. Fields: `leaseId`, `consumedAt` (epoch ms from
`Clock.currentTimeMillis` at projection time), `cause` (the original
`RpcServerError`), `message` (derived from `cause.message`). Constructed
only via `projectLeaseInvalid` or its Effect-pipe convenience
`catchLeaseInvalid`. Hosts inspect via `Match.tag("LeaseAlreadyConsumed", ...)`
or `instanceof LeaseAlreadyConsumed`.

### `projectLeaseInvalid` / `catchLeaseInvalid`

`projectLeaseInvalid` is synchronous. Predicate matches
`err.data.reason === "LeaseInvalid"` (today's `ForbiddenError` wire shape)
OR `err.data._tag === "LeaseAlreadyConsumed"` (forward-compat for a future
server that emits the canonical tag in `data` directly). Returns the
original `RpcServerError` unchanged when neither discriminant matches.

`catchLeaseInvalid({ leaseId })` is the Effect-pipe wrapper. It catches
`RpcServerError` failures, reads `Clock.currentTimeMillis` for the
`consumedAt` stamp, and feeds them to `projectLeaseInvalid`. Channels use
this at every `core.sendReply(...)` boundary.

### `LeaseStore<HostKey, T>`

Generic per-key tracker backed by an internal `Map`. API:
`remember(key, payload)`, `peek(key)` (read-only — preserves the stale-entry-
on-retry semantic), `consume(key)` (read-and-delete), `clear(key?)`,
`size`. All methods are Effects over `never` errors.

Nanoclaw stores `(jid, dispatchLeaseId)` and uses `peek` deliberately so
that retries after a consumed lease trigger the server's CONSUMED rejection
rather than silently falling back to an unleased send (cutover #533).

### `LeaseGuard`

Per-dispatch single-shot dup-reply detector. One instance per inbound
message. `consume()` returns `true` exactly once (and stamps `consumedAt`
from `Clock.currentTimeMillis`); every later call returns `false`.
`consumedAt` exposes the stamp as `Option<number>`.

Replaces openclaw's `consumedLeaseAt: number | null` closure inside
`createLeaseConsumingDeliver`.

### `formatCrossConv` / `formatGroupBlock` / `getGroupFields`

`formatCrossConv` accepts a markup variant (`"json-header"` for the
pre-refactor openclaw output, `"xml-system-reminder"` for nanoclaw) OR a
caller-supplied `CrossConvFormatter` callback. Returns `null` on empty input.
Channel-base owns the empty-check and the own-agent disambiguation; markup
ownership lives in the variant table or the callback.

`getGroupFields(meta)` is the shared type-narrowing predicate. Returns
`null` unless `meta?.type === "group"`; otherwise returns
`{ name, participants }`. Openclaw consumes the narrowed fields to derive its
`groupSubject` / `groupMembers` dispatch-context fields; nanoclaw routes them
into `formatGroupBlock(fields, { markup: "xml-system-reminder" })`;
claude-code does not consume group metadata at all (P3 #607 resolution —
adding a no-op consistency call would be dead code).

`formatGroupBlock(fields, { markup })` renders the formatted block.
`"xml-system-reminder"` emits the nanoclaw output verbatim;
`"json-header"` emits the empty string (openclaw does not render a group
block — it derives field values directly from `getGroupFields`).

## 3. Lease projection sequence

```mermaid
sequenceDiagram
    autonumber
    participant Host as Host agent
    participant Channel as Channel adapter
    participant Core as MoltZapChannelCore
    participant Server as MoltZap server

    Host->>Channel: reply / sendMessage(text)
    Channel->>Core: sendReply(conv, text, opts)
    Core->>Server: messages/send RPC
    Server-->>Core: ForbiddenError(data.reason=LeaseInvalid)
    Note over Channel,Core: catchLeaseInvalid reads Clock.currentTimeMillis<br>and runs projectLeaseInvalid
    Core-->>Channel: Effect.fail(LeaseAlreadyConsumed)

    alt claude-code
        Channel->>Host: toolErrorResult LeaseAlreadyConsumed
    else openclaw
        Channel->>Host: onLeaseConsumed callback; deliver returns false
    else nanoclaw
        Channel->>Host: Effect raises typed LeaseAlreadyConsumed
    end
```

The `_tag === "LeaseAlreadyConsumed"` forward-compat arm of the predicate
covers a future server change to emit the canonical tag in `data` directly;
no channel-side update would be required.

## 4. Per-channel worked examples

### Openclaw (`json-header` markup, `onLeaseConsumed` opt-in)

```ts
import {
  LeaseGuard,
  catchLeaseInvalid,
  formatCrossConv,
  getGroupFields,
} from "@moltzap/client/channel-base";

const guard = new LeaseGuard();

const crossConv = formatCrossConv(messages, {
  ownAgentId: service.ownAgentId ?? "",
  markup: "json-header",
});

const groupFields = getGroupFields(enriched.conversationMeta);
const groupSubject = groupFields?.name;
const groupMembers =
  groupFields !== null ? groupFields.participants.join(",") : undefined;

// Inside createLeaseConsumingDeliver:
core
  .sendReply(conv, text, { dispatchLeaseId: leaseId })
  .pipe(catchLeaseInvalid({ leaseId }));
```

Host opts in to the typed lease error via plugin deps:

```ts
const plugin = createMoltzapChannelPlugin({
  onLeaseConsumed: (err) => log.warn(`lease ${err.leaseId} consumed`),
});
```

### Nanoclaw (`xml-system-reminder` markup, `LeaseStore`)

```ts
import {
  LeaseStore,
  catchLeaseInvalid,
  formatCrossConv,
  formatGroupBlock,
  getGroupFields,
} from "@moltzap/client/channel-base";

const dispatchLeases = new LeaseStore<string, string>();

// Inbound: remember the lease.
yield* dispatchLeases.remember(chatJid, enriched.dispatchLeaseId);

// Outbound: peek-style (stale-entry-on-retry by design).
const leaseEntry = yield* dispatchLeases.peek(jid);
const leaseId = Option.getOrUndefined(leaseEntry);
yield* core
  .sendReply(conv, text, { dispatchLeaseId: leaseId })
  .pipe(catchLeaseInvalid({ leaseId }));

// Context blocks via xml-system-reminder markup.
const crossConv = formatCrossConv(messages, {
  ownAgentId,
  markup: "xml-system-reminder",
});
const fields = getGroupFields(meta);
if (fields !== null) {
  blocks.push(formatGroupBlock(fields, { markup: "xml-system-reminder" }));
}
```

### Claude-code (no group-block; tool-error path unchanged)

```ts
import {
  LeaseAlreadyConsumed,
  catchLeaseInvalid,
} from "@moltzap/client/channel-base";

core.sendReply(conv, text).pipe(
  catchLeaseInvalid(), // no leaseId ctx; falls back to "(unknown)"
  Effect.mapError((cause): ReplyError =>
    cause instanceof LeaseAlreadyConsumed
      ? cause
      : new SendFailed({ cause: stringifyCause(cause) }),
  ),
);
```

`server.ts → toolErrorResult` already surfaces `LeaseAlreadyConsumed` as a
tool-error; only the import site moved.

## 5. Why no high-level `createChannelBase` helper (OQ2 resolution)

Spec §"Open questions" OQ2 resolved to **A — primitives only**. The three
channels deliberately diverge on surfacing path (claude-code tool-error,
openclaw side-channel callback, nanoclaw Effect raise), and on context-block
markup. A high-level `createChannelBase(opts)` helper would either:

- Hard-code one surfacing path, defeating the per-host contract — or
- Accept callbacks for each path, at which point the helper would be a
  thin facade over the primitives below it.

Neither option carries weight; primitives are the cleaner abstraction.

## 6. See also

- Spec: chughtapan/moltzap#597
- Architect plan: chughtapan/moltzap#605
- `packages/openclaw-channel/docs/architecture/deliver-error-handling.md`
- `packages/nanoclaw-channel/docs/architecture/outbound-send-message.md`
- `packages/claude-code-channel/docs/architecture/lease-state-machine.md`
