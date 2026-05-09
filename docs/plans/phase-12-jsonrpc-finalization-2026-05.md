# Phase 12 expanded — JSON-RPC layered finalization

**Branch:** `staff/452-phase-12-protocol-finalization`
**Worktree:** `/home/tapanc/.worktrees/moltzap-phase-12-protocol`
**Anchor issue:** [#452](https://github.com/chughtapan/moltzap/issues/452)
**Parent epic:** [#415](https://github.com/chughtapan/moltzap/issues/415) — layered network refactor (11-phase)
**Predecessor plan:** [`layered-network-refactor-2026-05.md`](./layered-network-refactor-2026-05.md) — Phase 12 was a user-authorized addition post-Phase-7 audit; this document is its detailed scope after the expansion confirmed in this session.
**Drafted:** 2026-05-06
**State at draft time:** ~137 files modified in working tree (in-flight Phase 12 cleanup); 9 sibling issues OPEN that this plan absorbs and closes.

## Execution status (live)

| Step | Commit | State |
|------|--------|-------|
| S1 — Layered cleanup pre-JsonRpcClient/Server | `c44794a` | ✅ landed |
| S2 — Tagged-error classes + global wire-code registry | `c91e1b4` | ✅ landed |
| S5 — JsonRpcClient (originator-side abstraction) | `9d2fd77` | ✅ landed |
| S7 — JsonRpcServer (responder-side abstraction) | `76f35ee` | ✅ landed |
| S6 — Encapsulate id-correlation client-side; trim narrative | `6779085` | ✅ landed |
| S11 — Namespace-introspection wire-method-name union | n/a — already in place | ✅ via existing `(typeof rpcMethods)[number]["name"]` |
| S12 — Issue close-out evidence comments | n/a — `gh issue comment` | ✅ posted on #437, #405–#412 |
| **S8a** — Server-side encapsulation: `appCallbackPending`/`appCallbackRequestCounter` Refs → `jsonRpcClient: JsonRpcClient` | (pending push) | ✅ landed locally — `MoltZapConnection.jsonRpcClient` replaces both Refs; `AppCallbackRpc*` tagged classes deleted; `completeAppCallbackResponse` deleted (server inlines `conn.jsonRpcClient.resolve`); pending-size assertions deleted (predicate-tautology) — exit-shape and `resolve(...) === false` are the observable equivalents |
| **S8b** — Dispatch swap: replace `server/rpc/router.ts` with `JsonRpcServer.handle` | (pending push) | ✅ landed locally — `router.ts` deleted (−109 LOC); `RpcMethodNotFoundError` / `RpcParamsDecodeError` / `RpcResolveError` / `ResolvedRpcMethod` / `RpcMethodBoundaryService` / `RpcMethodBoundaryTag` / `makeRpcMethodBoundaryService` / `makeRpcMethodBoundaryLayer` / `rpcResolveErrorResponse` all deleted; `defineMethod` now produces `RpcHandler<D, DispatchContext>` directly (matches `JsonRpcServer`'s shape — no resolve indirection); `server.ts` constructs `makeJsonRpcServer<DispatchContext>(methods, logger)` and calls `jsonRpcServer.handle(frame, {auth, connId})` from one inline branch. Net −220 LOC. |
| **S4** — Handler retag (~50 sites) + delete `RpcFailure` | (pending push) | ✅ landed locally — `RpcFailure` + factory helpers (`notFound`/`forbidden`/etc.) all deleted; raise sites use `new NotFoundError({message})` / `new ForbiddenError({message})` directly; tagged classes accept `{message?, data?}`; `internalError` calls collapsed to `Effect.die(...)` (defects); `router.ts` reads `wireErrorFromInstance` for any tagged class; `defineMethod` + `defineLayered*` accept generic `E = never` so per-handler error channels stay precise. Per-service union type aliases (`ConversationServiceError`, `MessageServiceError`, `TaskServiceError`, `ContactsServiceError`) replace the wide `RpcFailure`. |
| **S9** — Notification fail-close + collapse `Raw\|Unknown` types | (pending push) | ✅ landed locally — wire decoder uses `decodeNotification` (fail-close on unknown method + invalid params); `RawDecodedNotification`, `UnknownDecodedNotification`, `DecodedNotificationFrame` types deleted; `validateNotificationParams` + `acceptTypedNotification` lifters deleted; `notification-types.types-check.ts` canary deleted; `service.typed-bridge.test.ts` + `ws-client.typed-bridge.test.ts` deleted; `frame.test.ts` rewritten to assert fail-close on stale shapes. Closes #437. |
| **S10** — Transport + methods folder file collapse | (pending push) | ✅ landed locally — `transport/{ajv,errors,frames,frames.test,json-rpc,notification,rpc,transport}.ts` (8 files) collapsed into `transport/wire.ts` + `transport/method.ts`. Per-layer `methods/*.ts` (8 files) collapsed into single `{network,identity,task,app}/methods.ts`. `RpcBoundaryService`/`NotificationBoundaryService` + their factories trimmed (dead post-S8b). One place to add a new RPC or notification per layer. |
| **S13** — Final pre-PR gates (typecheck/lint/test/integration/conformance/simplify/codex) | pending | 🔄 after S8+S4+S9+S10 |

PR: https://github.com/chughtapan/moltzap/pull/493 (draft, stacked).

---

## 1. Intent

Land the architectural finalization of moltzap's JSON-RPC protocol layer: introduce `JsonRpcClient` and `JsonRpcServer` as the protocol's outbound/inbound primitives, colocate domain error codes onto their method descriptors, fail-close on every wire boundary, and consolidate `transport/` from 8+ thin files into a tight 4-file shape. Close 9 sibling issues whose work was completed by prior phases or by this plan.

This is the final pass to make the protocol package the single source of truth for JSON-RPC contract — wire shape, method definitions, error tags, dispatch primitives — with no residual logic scattered across `server/rpc/` or `client/runtime/`. After this phase: `@moltzap/protocol` is the contract; `@moltzap/server` and `@moltzap/client` are wirings of that contract to specific transports + handlers.

## 2. Why now

### 2.1 Four architectural gaps surfaced by the in-flight Phase 12 work

| Gap | Symptom | Why it matters |
|---|---|---|
| **Duplicate RPC roundtrip implementations** | `client/ws-client.ts:sendRpcTracked` (~85 LOC), `server/ws/connection.ts:sendAppCallback` (~95 LOC), `protocol/testing/test-client.ts:sendRpc` (~50 LOC) all reimplement: mint id → register Deferred → write → await with timeout → cleanup | ~230 LOC of duplicated correlation logic. ID-minting leaks (`rpc-N`, `srv-CONNID-N`, `tc-N`) drag the brand factory out as public surface. |
| **Inbound dispatch scattered** | `protocol/transport/rpc-groups.ts` (520 LOC), `server/rpc/router.ts` (~100), `server/rpc/context.ts` (~150) — 770 LOC across 3 files, 2 packages | No single owner of "JSON-RPC inbound dispatch contract." Asymmetric with the (also-scattered) outbound side. |
| **Domain error codes lumped in `transport/errors.ts`** | 24 codes spanning JSON-RPC reserved (5) + auth (4) + contacts (2) + conversations (2) + apps/agents (8) + generic (3) | A numeric code without a method is meaningless contract. `ErrorCodes.NotInContacts` doesn't tell a reader which RPC raises it, what catch-tag the client uses, or what recovery semantics apply. |
| **Transport file split is artificial** | 10 files in `transport/`: ajv (30) + errors (48) + frames (155) + index (15) + json-rpc (24) + notification (31) + rpc-errors (32) + rpc (121) + rpc-groups (520) + transport (63) | Each file is below cohesion threshold. The split was historical (before descriptors existed). Cohesive consolidation: 4 files. |

These four collapse into one architectural move: define `JsonRpcClient` + `JsonRpcServer` as the protocol's outbound/inbound primitives, colocate errors with their methods, fail-close everywhere, consolidate.

### 2.2 Boundary fail-close discipline (Principle 2 + Principle 4)

The protocol currently has one passthrough hole: client-side `frame.ts:toDecodedNotification` emits `UnknownDecodedNotification` for notification methods absent from `notificationGroup.byName`. This was a deliberate weakening introduced by [PR #436](https://github.com/chughtapan/moltzap/pull/436) to accommodate conformance harness's `arbitraryNotificationFrame()` and `params.__emissionTag`; the weakening generated [#437](https://github.com/chughtapan/moltzap/issues/437) as follow-up.

Phase 12 closes this hole by failing closed on unregistered notification methods. Three justifications:

1. **Single-producer trust isn't a real invariant in this codebase.** Channels (`openclaw-channel`, `nanoclaw-channel`), `client/test-utils/fake-service.ts`, and conformance fixtures all decode notifications. Not just "the server."
2. **Passthrough is operationally indistinguishable from a routing bug.** If the server starts emitting `task/newThing` and the client doesn't know it, today's code silently passes through as `UnknownDecodedNotification`. We get no signal that protocol drift exists; it manifests as "things stopped working" weeks later.
3. **Fail-close is the established pattern everywhere else.** `Match.exhaustive` on every union switch (Principle 4). All hooks fail-CLOSED per the layered-refactor plan §2.4. `decodeRpcCall` returns `Effect.fail(UnknownMethodError)`. Server's inbound notification path already fails closed (`Match.tag("Notification", () => sendInvalidRequest(null))`). Notifications were the lone outlier.

### 2.3 Type-system tightening drives test deletion (Principle 1)

The user-stated invariant: **if a test would pass purely by virtue of typecheck once types are tight, delete it.** The test was the prosthesis.

Several existing test files exist precisely because the type system was loose:
- `router.test.ts` (226 LOC, synthetic Probe RPCs) — already deleted in S1 prep; JsonRpcServer makes handler/descriptor mismatch a typecheck error
- `validators.test.ts` (40 LOC, asserts validator names exist) — already deleted in S1 prep; descriptor structure makes `validateParams` existence by-construction
- `notification-types.types-check.ts` (#455 canary) — `Raw|Unknown` discrimination collapses when the boundary fails-closed
- Tests for `subscribers.ts` lift-from-Raw-to-Decoded — same collapse
- Tests exercising `arbitraryNotificationFrame()` passthrough — replace with positive "client receiving unregistered method emits `UnknownNotificationMethodError`" assertion
- Tests asserting wire-error-code → catch-tag mapping per pair — replace with one divergence-proof asserting descriptor consistency

Net effect: phase 12 expanded scope adds **negative-LOC** to test directories. Estimated diff: +1200 / -2700.

## 3. Architectural decisions

The decisions below were brainstormed in this session. They are the contract this plan ratifies.

### 3.1 Outbound: `JsonRpcClient`

A Scope-bound abstraction owning the originator side of an RPC connection:

```ts
// packages/protocol/src/transport/json-rpc-client.ts
export interface JsonRpcClient {
  // Outbound RPC: brand-internal id mint + correlation + timeout + cleanup.
  // Tagged errors decoded via descriptor.errorByCode.
  // Fails fast with NotConnectedError if Scope closed (acquireUseRelease).
  call<D extends RpcDefinition<any, any, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: { timeoutMs?: number },
  ): Effect.Effect<
    ResultOf<D>,
    ErrorTagsOf<D> | NotConnectedError | RpcTimeoutError
  >;

  // Inbound: feed a Response frame; resolves matching Deferred.
  resolve(frame: ResponseFrame): Effect.Effect<void>;

  // Finalizer: drain all pending with a typed error.
  failAllPending(error: NotConnectedError): Effect.Effect<void>;
}

export const makeJsonRpcClient = (config: {
  write: (raw: string) => Effect.Effect<void, WriteError>;
  idPrefix: string;          // "rpc" | `srv-${connId}` | "tc"
  defaultTimeoutMs: number;
}): Effect.Effect<JsonRpcClient, never, Scope.Scope>;
```

**Rationale.** `JsonRpcClient` is purely the originator side: outbound calls + own-response correlation. Both ends of a connection hold one — server-side mints `srv-${connId}` ids for appCallback requests; client-side mints `rpc-N` for user requests; test-client mints `tc-N`.

**Notification dispatch lives on JsonRpcServer (§3.2)**, not here. Notifications are inbound responder-side traffic; the responder dispatches them. JsonRpcClient handles only outbound + own-response correlation.

**Brand internalization.** ID-minting is internal; `idPrefix` is config. Brand factory `jsonRpcId` deletes from public surface. Frame builders (`requestFrame`/`responseFrame`) accept `string | null` and brand internally. Brand never appears in caller code.

**Finalizer ordering** (resolves §7 risk #1). `call` uses `Effect.acquireUseRelease`: acquire registers the pending entry, use awaits the Deferred, release removes it. Scope is the single source of truth — post-close `call` fails at acquire (Effect's Scope semantics) before touching any state. No duplicate "is closed" Ref bit. The connection's Scope is parent; closing it auto-runs JsonRpcClient's `failAllPending` finalizer first, then any subsequent acquire fails fast.

### 3.2 Inbound RPC: `JsonRpcServer`

The inbound RPC dispatcher. **Notifications are NOT here** — they're a separate concern (§3.2b) because notifications flow one direction (server → client) and don't fit the responder model.

```ts
// packages/protocol/src/transport/json-rpc-server.ts
export interface RpcHandler<D extends RpcDefinition<any, any, any, any>> {
  readonly definition: D;
  readonly handle: (
    params: ParamsOf<D>,
    ctx: AuthContext,
  ) => Effect.Effect<ResultOf<D>, ErrorTagsOf<D>>;
}

export interface AuthContext {
  readonly authenticated: { agentId: AgentId; ownerUserId: UserId | null } | null;
  readonly connId: string;
}

export interface JsonRpcServer {
  // Inbound Request: validate params, dispatch handler, build response.
  // Maps tagged-error failure → wire error response via descriptor.errorByCode.
  handle(
    frame: RequestFrame,
    ctx: AuthContext,
  ): Effect.Effect<ResponseFrame>;
}

export const makeJsonRpcServer = (
  rpcHandlers: ReadonlyArray<RpcHandler<any>>,
): JsonRpcServer;
```

**Rationale.** RPC requests flow both directions (client→server normal RPCs; server→client appCallback RPCs). Both ends respond, so both ends hold a JsonRpcServer:

| Side | Outbound RPC | Inbound RPC |
|---|---|---|
| Originator (`JsonRpcClient`) | `call(def, params)` | `resolve(responseFrame)` |
| Responder (`JsonRpcServer`) | `handle` returns `ResponseFrame` | `handle(requestFrame)` |

- **Server-side:** JsonRpcServer with full RPC handler set (handles client-originated requests). JsonRpcClient with `srv-${connId}` id-prefix (originates appCallback RPCs).
- **Client-side:** JsonRpcServer with taskCallback handlers (handles server-originated taskCallback requests). JsonRpcClient with `rpc-N` id-prefix (originates user-driven RPCs).

### 3.2b Inbound notifications (client-side only)

Notifications flow server → client only. The client decodes them via a free function in `transport/method.ts`; no JsonRpcServer involvement.

```ts
// In transport/method.ts:
export const decodeNotification = (
  frame: NotificationFrame,
): Effect.Effect<
  DecodedNotification<any>,
  UnknownNotificationMethodError | InvalidNotificationParamsError
> => {
  const definition = transport.notificationByName(frame.method);
  if (definition === undefined) {
    return Effect.fail(new UnknownNotificationMethodError({ method: frame.method }));
  }
  if (!definition.validateParams(frame.params)) {
    return Effect.fail(
      new InvalidNotificationParamsError({ method: frame.method, definition }),
    );
  }
  return Effect.succeed({ _tag: "Notification", definition, ...frame } as DecodedNotification<typeof definition>);
};
```

The client-side reader fiber routes:

```ts
yield* decodeFrame(parsed).pipe(
  Effect.flatMap((decoded) => Match.value(decoded).pipe(
    Match.tag("Response", ({ frame }) => jsonRpcClient.resolve(frame)),
    Match.tag("Request",  ({ frame }) => jsonRpcServer.handle(frame, ctx).pipe(Effect.flatMap(sendFrame))),
    Match.tag("Notification", ({ frame }) => decodeNotification(frame).pipe(
      Effect.flatMap((decoded) => subscribers.dispatch(decoded)),
      Effect.catchAll((err) => logMalformedNotification(err)),  // fail-close, drop
    )),
    Match.exhaustive,
  )),
);
```

**Server-side** keeps its existing `Match.tag("Notification", () => sendInvalidRequest(null))` — the server doesn't accept inbound notifications, returns InvalidRequest response. No `decodeNotification` call on the server.

**Notification emission** (server → client) is also outside any abstraction — server code calls `notificationFrame(def, params)` (the existing builder) and writes to the socket. Already a one-liner; no further consolidation needed.

### 3.3 Per-method error colocation (with file collapse)

Methods folder collapses per-layer (§3.9): `*/methods/{a,b,c}.ts` → `{layer}.ts`. Within each layer file, descriptors declare errors via the new `errors:` field:

```ts
// protocol/src/identity.ts (post-collapse: contains all identity descriptors)
import { Data } from "effect";
import { AgentNotFoundError, NotInContactsError, BlockedError } from "./transport/wire.js";

// Identity-layer-only error
class IdentityRejectedError extends Data.TaggedError("IdentityRejected")<{}> {
  static readonly code = -32016;
  static readonly message = "Identity rejected";
}

export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  paramsSchema: AgentsLookupParamsSchema,
  resultSchema: AgentsLookupResultSchema,
  errors: { AgentNotFound: AgentNotFoundError },  // wire-shared class
});

export const ContactsAdd = defineRpc({
  name: "contacts/add",
  paramsSchema: ContactsAddParamsSchema,
  resultSchema: ContactsAddResultSchema,
  errors: {
    AgentNotFound: AgentNotFoundError,            // wire-shared
    NotInContacts: NotInContactsError,            // wire-shared
    Blocked: BlockedError,                        // wire-shared
  },
});

// Handler raises the class, not a wire-code object:
return yield* Effect.fail(new NotInContactsError());

// Client side, JsonRpcClient maps wire response.error.code → descriptor's error class.
// Multiple descriptors share AgentNotFoundError → catchTag works across all of them:
yield* jsonRpcClient.call(ContactsAdd, params).pipe(
  Effect.catchTag("AgentNotFound", () => /* one handler covers AgentsLookup, ContactsAdd, MessagesSend, ... */),
);
```

**Layer dependency rule (one-way): `app → task → network/identity → transport`.** Errors live at the **lowest** layer that defines the concept; higher layers import them.

| Scope | Location | Examples |
|---|---|---|
| **Identity-domain shared** (the concept "agent"/"contact" is owned by identity; task imports) | Top of `identity.ts` | `AgentNotFoundError -32011` (used by `AgentsLookup`, `ContactsAdd` in identity AND `MessagesSend` in task — task imports), `NotInContactsError -32005`, `BlockedError -32006` |
| **Task-domain shared** (concept owned by task) | Top of `task.ts` | `TaskClosedError -32020` (7 task methods), `ConversationArchivedError -32022` (3 task methods) |
| **App-domain shared** (concept owned by app) | Top of `app.ts` | `HookBlockedError -32019`, `AppNotFoundError -32010` |
| **Method-specific** (code on exactly one descriptor) | Inline on the descriptor's `errors:` field | `MaxParticipants -32017` (only on `ConversationsAddParticipant`), `IdentityRejected -32016` (only on `Connect`), `AgentNoOwner -32018` (only on `Connect`) |
| **Wire/transport-only** (not domain — JSON-RPC reserved or auth-gate) | `transport/wire.ts` | `JSON_RPC_RESERVED_CODES.{ParseError, InvalidRequest, MethodNotFound, InvalidParams, InternalError}`, `TRANSPORT_ERROR_CODES.{Unauthorized, Forbidden, RateLimited, ProtocolMismatch}` |

**No domain errors in `transport/wire.ts`.** Wire owns the JSON-RPC frame primitives and the codes that are protocol-level (reserved -32xxx) or auth-gate level (Unauthorized at WS layer). Domain concepts ("agent doesn't exist", "task is closed") belong to their owning layer.

**Linter enforcement.** Existing ESLint `no-restricted-imports` rule (added Phase 4) prevents identity from importing task. Continues to apply: identity-error imports flow downward only.

**Tag-uniqueness invariant.** Each error class is declared once. `_tag` strings are bare names (`"AgentNotFound"`, not `"ContactsAdd.AgentNotFound"`). `Effect.catchTag(...)` works across any descriptor that references the shared class.

**JsonRpcServer error encoding.** Handler raises `new AgentNotFoundError()` → JsonRpcServer wraps in `Effect.catchTag("AgentNotFound", ...)` (one per declared error tag) → maps to wire response via `class.code` static field.

**JsonRpcClient error decoding.** Inbound response with `error.code = -32011` → looks up `descriptor.errorByCode.get(-32011)` → instantiates the class → fails the call's Effect with that tag. Single class means single tag means catchTag works.

**Divergence-proof gate** (still useful as a sanity check): walk all descriptors, assert that for any shared class referenced from multiple descriptors, the class's `code` and `message` match what each descriptor declares. Should be trivially true since they all reference the same class.

### 3.4 Decision A — single error pattern: tagged classes as monadic returns

**Chosen (A2-extended):** every error is a `Data.TaggedError` class with static `code` and `message`. Handlers return them via `Effect.fail` (monadic, typed error channel — Principle 3). No `throw`. No `RpcFailure` envelope.

```ts
// Handler:
handle: (params, ctx) =>
  Effect.gen(function* () {
    if (!ctx.authenticated) {
      return yield* Effect.fail(new UnauthorizedError());
    }
    const agent = yield* findAgent(params.agentId);
    if (agent === null) {
      return yield* Effect.fail(new AgentNotFoundError());
    }
    return { /* ResultOf<D> */ };
  })

// Type signature derived from descriptor:
handle: (params, ctx) => Effect.Effect<ResultOf<D>, ErrorTagsOf<D>>;
// where ErrorTagsOf<D> = InstanceType<D["errors"][keyof D["errors"]]>

// JsonRpcServer wraps handler:
handler(params, ctx).pipe(
  ...definition.errors map to Effect.catchTag("TagName", err =>
    Effect.succeed(responseFrame(frame.id, { error: { code: ErrorClass.code, message: err.message ?? ErrorClass.message } }))
  ),
  Effect.catchAllCause(cause =>  // defect safety net
    Effect.succeed(responseFrame(frame.id, { error: { code: -32603, message: "Internal error" } }))
  ),
)
```

**Cross-cutting errors are tagged classes too** — `UnauthorizedError`, `ForbiddenError`, `RateLimitedError`, `ProtocolMismatchError` live in `transport/wire.ts` (transport-layer concerns, not domain-specific). Auth gate raises `new UnauthorizedError()` exactly the same way a method handler raises `new AgentNotFoundError()`. JsonRpcServer's catchTag chain catches both equally.

**`RpcFailure` deletes entirely.** Single pattern, no envelope, no dual mental model. ~10 server-side raise sites retag. The type system is the contract: `ErrorTagsOf<D>` is derived from descriptor's `errors:` field — adding/removing an error class is a typecheck-enforced contract change for every handler and caller.

**Rejected (A1):** handlers keep raising `RpcFailure`. Less churn, but loses Principle 1 (types beat tests) — wire codes via numeric literals remain the linkage instead of tagged classes.

**Rejected (A2-original):** keep `RpcFailure` only for cross-cutting. Two patterns coexisting forever for no reason; cross-cutting tags work just as well as method-scoped tags.

### 3.5 Decision B — JSON-RPC reserved codes location

**Choice B1 (recommended):** `transport/wire.ts` exports `JSON_RPC_RESERVED_CODES = { ParseError: -32700, InvalidRequest: -32600, MethodNotFound: -32601, InvalidParams: -32602, InternalError: -32603 } as const`. JsonRpcServer uses these directly when emitting wire-level error responses (no method available to tag against).

**Rejected (B2):** put on a sentinel descriptor for symmetry with method descriptors. Reserved codes aren't method-scoped; the descriptor framing doesn't fit.

### 3.6 Decision C — Cross-cutting error codes

**Choice C1 (recommended):** `transport/wire.ts` exports `TRANSPORT_ERROR_CODES = { Unauthorized: -32000, Forbidden: -32001, NotFound: -32002, Conflict: -32003, RateLimited: -32004, ProtocolMismatch: -32008 } as const`. `RpcFailure` (in server/runtime) keeps for these cases.

**Rejected (C2):** split into per-domain error files. Adds churn without clarity gain — these codes really aren't domain-specific.

### 3.7 Decision D — Naming the outbound/inbound abstractions

**Chosen:** `JsonRpcClient` and `JsonRpcServer`.

**Why:** anchored to the JSON-RPC 2.0 wire spec, transport-agnostic, standard nomenclature. Doesn't collide with `MoltZapWsClient` (which composes a `JsonRpcClient` plus WebSocket lifecycle plus reconnect plus subscriptions). Composes naturally with future `JsonRpcConnection` if/when bidirectional bundling is wanted (NOT this phase).

**Rejected:**
- `RpcCaller` / `RpcDispatcher` / `RpcChannel` — generic; lose the "speaks JSON-RPC 2.0 specifically" anchor
- `PendingRpcRegistry` / `RpcMethodRegistry` — passive-lookup framing; the abstraction is active

### 3.8 Decision E — Notification fail-close

**Chosen:** unregistered notification methods fail-close at `JsonRpcServer.dispatchNotification`. The `UnknownDecodedNotification` and `RawDecodedNotification` types collapse — there's only `DecodedNotification<D>` with both `definition` and validated `params`.

**Why:** see §2.2. The conformance harness's `arbitraryNotificationFrame()` retargets to assert "fail-close happens" rather than work around it.

**Rejected:** keep passthrough with stricter logging. Same operational problem (silent drift), heavier diff.

### 3.9 Decision F — Transport file structure + methods folder collapse

**Transport directory: 4 production files + 1 transport-error file + 1 ajv singleton:**

```
packages/protocol/src/transport/
  wire.ts                — JsonRpc* constants + frame schemas/builders/decoder + AJV/RpcErrorSchema +
                           JSON-RPC reserved codes + transport-layer codes (Unauthorized/Forbidden/RateLimited/ProtocolMismatch).
                           NO domain errors here — those live in their owning layer file.
  method.ts              — RpcDefinition, defineRpc, NotificationDefinition, defineNotification,
                           transport singleton, decodeRpcCall, decodeRpcParams, defineRpcGroup,
                           defineNotificationGroup, DecodedRpcRequest/DecodedNotification types
  json-rpc-client.ts     — JsonRpcClient + makeJsonRpcClient
  json-rpc-server.ts     — JsonRpcServer + makeJsonRpcServer (handle + dispatchNotification)
  rpc-errors.ts          — NotConnectedError, RpcTimeoutError, RpcServerError (transport-layer wire failures,
                           not method-level — these wrap the wire frame, they're not encoded into one)
  ajv.ts                 — singleton (or inlined into wire.ts; decision deferred to S10)
```

**Layer files: per-layer collapse (eliminates `*/methods/` subdirs):**

```
packages/protocol/src/
  identity.ts                              — was identity/methods/{agents,contacts,invites}.ts +
                                             identity/notifications/*.ts. Contains all identity descriptors
                                             + within-identity-shared error classes at top of file
  network.ts                               — was network/methods/{connect,ping,presence}.ts +
                                             network notifications. Contains Connect, NetworkPing,
                                             PresenceUpdate, PresenceSubscribe + PresenceChanged notification
  task.ts                                  — was task/methods/{messages,conversations,tasks}.ts +
                                             task notifications. Within-task-shared error classes
                                             (TaskClosedError, ConversationArchivedError) at top
  app.ts                                   — was app/methods/hooks.ts + app notifications
```

Within each layer file, descriptors that share a code reference a single class declared once at the top of the file. Cross-layer shared errors live in `transport/wire.ts`. Method-specific errors stay inline.

**Files deleted:**
- `transport/frames.ts` → folds into `wire.ts`
- `transport/errors.ts` → folds (codes into wire.ts; envelope schema into wire.ts)
- `transport/json-rpc.ts` → folds into `wire.ts`
- `transport/notification.ts` → folds into `method.ts`
- `transport/rpc.ts` → folds into `method.ts`
- `transport/transport.ts` → folds into `method.ts` (singleton)
- `transport/rpc-groups.ts` → split: dispatch/decode logic into `json-rpc-server.ts`; group containers + decoded types into `method.ts`
- `transport/index.ts` → deletes; `protocol/src/index.ts` becomes explicit allowlist
- `identity/methods/{agents,contacts,invites}.ts` (3 files) → fold into `identity.ts`
- `network/methods/{connect,ping,presence}.ts` (3 files) → fold into `network.ts`
- `task/methods/{messages,conversations,tasks}.ts` (3 files) → fold into `task.ts`
- `app/methods/hooks.ts` → fold into `app.ts`
- All `*/notifications/` co-located files → fold into the layer file (notifications are the same descriptor shape as methods; they share state with the methods they relate to)
- `*/index.ts` re-export files for each layer → deletes (layer file IS the index)

**Net file count:** transport/ 10 → 6; layer files ~13 method files + ~10 notification files + ~4 index re-exports → 4. Total `protocol/src/` net: ~30 → ~12 production files. **Diff impact: large but mechanical** (concat + import-rewrite).

### 3.10 Decision G — Type-system tightening replaces residual tests

Per Principle 1: tests that exist because types are loose, get deleted when types tighten.

| Test | Type-side replacement | Status |
|---|---|---|
| `router.test.ts` (226 LOC) | JsonRpcServer typed `RpcHandler<D>[]` rejects mismatch at typecheck | Deleted in S1 prep |
| `validators.test.ts` (40 LOC) | Each descriptor's `validateParams` is structurally tied to `paramsSchema` | Deleted in S1 prep |
| `notification-types.types-check.ts` | `DecodedNotification<D>` is the only post-decode shape; no Raw/Unknown discrimination | S9 deletion |
| Subscribers `lift` machinery + tests | Lift function deletes when union collapses | S9 deletion |
| `arbitraryNotificationFrame` passthrough tests | Single positive: "unregistered notification → `UnknownNotificationMethodError`" | S9 retarget |
| `frames.test.ts` (170 LOC) builder-output tests | Builder return types are typecheck assertions | S10 trim |
| Per-pair wire-error-code → catch-tag mapping tests | One divergence-proof on `descriptor.errorByCode` consistency | S2 |
| `MakeRpcBoundaryService` / `RpcBoundaryService` tests | Surface deletes | S8 |

**Surviving tests** (these earn their keep):
- Wire-shape tests on crafted bytes (AJV runtime behavior; types can't reach raw bytes)
- Conformance suite properties (behavioral invariants end-to-end)
- Integration tests (cross-package flows, service-layer behavior, timing)

## 4. Issue absorption matrix

| Issue | State | Disposition | Evidence to post |
|---|---|---|---|
| **#437** Re-tighten frame.ts inbound-params boundary | OPEN | **Absorbed.** Closed by fail-close on unknown notification method (§3.8). Stronger than the issue's "either re-tighten or document why weakening is safe" — chosen path is to delete the weakening entirely. | Diff at `client/runtime/frame.ts` showing passthrough deleted; conformance suite green with retargeted assertion. |
| **#405** [spec] Standard JSON-RPC frame cleanup | OPEN | **Already complete** via Phase 0 (PR #414, merged) + Phase 1C (PR #429, merged) + Phase 12 wire renames. | Comment listing: standard JSON-RPC 2.0 frames in `wire.ts` (RequestFrame, ResponseFrame, NotificationFrame); no custom envelope fields; AJV singleton; `RpcServerError`/`NotConnectedError`/`RpcTimeoutError` lifted to protocol per #418. |
| **#406** [architect] Architecture for JSON-RPC frame cleanup | OPEN | **Already complete** via Phase 0+1C architecture. | Comment citing plan-doc §2.2/§2.3 + the three merged PRs. |
| **#407** [implement] Implement JSON-RPC frames | OPEN | **Already complete** via Phase 0+1C+12. | Diff summary across the four PRs (#414, #429, #418, #452). |
| **#408** [verify] Verify and land JSON-RPC frame cleanup | OPEN | **Verifies after expanded #452 PR merges.** | Verify comment mapping each acceptance criterion. |
| **#409** [spec] TypeBox-derived Effect RPC descriptors | OPEN | **Already complete** via existing `defineRpc` machinery + per-method `errors:` extension landing in #452. | Comment: TypeBox canonical; AJV at boundary; descriptors typed via `defineRpcGroup`; spike #401 outcome linked. |
| **#410** [architect] Descriptor architecture | OPEN | **Already complete.** | Comment: descriptor shape + per-method `errors:` + handler typing through `RpcHandler<D>` in JsonRpcServer. |
| **#411** [implement] Implement descriptors | OPEN | **Already complete + extended in #452.** | Diff: every existing RPC uses `defineRpc({name, paramsSchema, resultSchema, errors})`. JsonRpcServer dispatches via descriptor. |
| **#412** [verify] Verify and land descriptors | OPEN | **Verifies after expanded #452 PR merges.** | Verify comment. |
| **#453** [Phase 13] Per-package intra-module organization | OPEN | **Stays open.** #452 narrows #453's scope by handling `transport/` cleanup + comment debt in protocol. #453 still owns the audit + cleanup of the other 8 packages. | Follow-up comment on #453 noting protocol pre-empted; updated audit table. |
| **#454** [Phase 14] Documentation refresh | OPEN | **Stays open.** Phase 12 updates wire-rename docs already in flight; #454 still owns the broader doc refresh. | n/a |

Net: **9 issues close** (1 follow-up + 4 spec/architect already-done + 4 verify after merge). #453 + #454 stay open with scope adjustments.

## 5. Sequencing

### S1 — Prep commit: land in-flight Phase 12 cleanup

Working tree has ~137 modified files from earlier session. Commit as one prep commit so the expanded-scope diff is reviewable separately.

**Includes:**
- Layered split + wire renames + notification co-location (the original #452 acceptance)
- Transport singleton (`transport/transport.ts`)
- `decodeFrame` Effect-shape with `FrameDecodeError` tagged error
- Server `handleFrame` refactored to `Effect.catchTag` + `Match.discriminator`
- Client `frame.ts` migrated off `validators.X` to `decodeFrame`
- `validators.ts` deleted (and consumers migrated)
- Brand factory `jsonRpcId` deletion in progress (builders accept plain strings, brand internally)
- `router.test.ts` deleted (coverage subsumed by integration tests + JsonRpcServer types in S7)
- `validators.test.ts` deleted

**Pending leftovers to finish before commit:**
- 4 `jsonRpcId` callsites still need migration: `app-callback-test-requests.ts`, `conformance-adapter.ts`, `ws-client.test.ts`, `rpc-semantics.ts`
- Drop `jsonRpcId` from `protocol/src/index.ts` exports
- Delete `transport/index.ts`; explicit allowlist in `protocol/src/index.ts`
- All packages typecheck green (`pnpm -r build`)

**Tag:** `phase-12-prep: layered cleanup pre-JsonRpcClient`

### S2 — Add `errors` field to descriptors

`packages/protocol/src/transport/method.ts` (post-collapse name; in S1 still `transport/rpc.ts`):

```ts
export interface RpcErrorDef {
  readonly code: number;
  readonly message: string;
  readonly dataSchema?: TSchema;
}

export interface RpcDefinition<Name, Params, Result, Errors = {}> {
  readonly name: JsonRpcMethod<Name>;
  readonly paramsSchema: Params;
  readonly resultSchema: Result;
  readonly errors: Errors;
  readonly validateParams: (v: unknown) => v is Static<Params>;
  readonly errorByCode: ReadonlyMap<number, { tag: string; def: RpcErrorDef }>;
}

export function defineRpc<...>(spec: { name, paramsSchema, resultSchema, errors? }): RpcDefinition<...>;
```

`errors` defaults to `{}`. Each error becomes a `Data.TaggedError(\`${methodName}.${tagName}\`)<{}>` class accessible at `MyMethod.errors.TagName`.

**Add divergence-proof gate test:** `descriptor-error-consistency.proofs.test.ts` — for every (code) appearing across descriptors, assert (message) agrees.

**Acceptance:** `defineRpc({errors: { Foo: { code: -32999, message: "x" }}})` produces a descriptor where `Method.errors.Foo` is constructable and `Method.errorByCode.get(-32999) === { tag: "Foo", def: ... }`.

### S3 — Migrate 19 domain error codes onto descriptors

Per-method assignment (codes → owning descriptor(s)):

| Code | Tag | Moves to |
|---|---|---|
| -32005 | NotInContacts | `ContactsAdd`, `MessagesSend` |
| -32006 | Blocked | `ContactsAdd`, `MessagesSend` |
| -32007 | ConversationFull | `ConversationsAddParticipant` |
| -32010 | AppNotFound | `AppsRegister`, `TaskAuthorizeDispatch` |
| -32011 | AgentNotFound | `AgentsLookup`, `AgentsLookupByName`, `MessagesSend`, `ContactsAdd` |
| -32016 | IdentityRejected | `Connect` |
| -32017 | MaxParticipants | `ConversationsAddParticipant` |
| -32018 | AgentNoOwner | `Connect` |
| -32019 | HookBlocked | `MessagesSend` |
| -32020 | TaskClosed | `TasksClose`, `MessagesSend`, `TasksAddParticipant`, `TasksRemoveParticipant`, `TasksStoreMessage`, `TasksGetMessages`, `TasksGetMessagesSince` |
| -32021 | SessionNotFound | (deprecated; verify no live usage; if dead, drop) |
| -32022 | ConversationArchived | `MessagesSend`, `ConversationsAddParticipant`, `ConversationsRemoveParticipant` |

Cross-cutting codes (`Unauthorized -32000`, `Forbidden -32001`, `NotFound -32002`, `Conflict -32003`, `RateLimited -32004`, `ProtocolMismatch -32008`) stay in `transport/wire.ts:TRANSPORT_ERROR_CODES`.

JSON-RPC reserved (5 codes -32700..-32603) stay in `transport/wire.ts:JSON_RPC_RESERVED_CODES`.

`transport/errors.ts` deletes after migration (S10).

### S4 — Migrate handler error-raise sites (Decision A2)

Two batches:

**Single pattern, all sites become tagged-class raises:**
```diff
- new RpcFailure({ code: ErrorCodes.NotInContacts, message: "..." })
+ new NotInContactsError()  // imported from identity.ts

- new RpcFailure({ code: ErrorCodes.Unauthorized, message: "..." })
+ new UnauthorizedError()  // imported from transport/wire.ts
```

After this step, `RpcFailure` has zero references. Delete `server/src/runtime/errors.ts` (the module that defined it).

Touch ~50 handler/auth-gate files. Mechanical sed-able pattern; batch by domain. Each site gains an import for the relevant tagged-error class.

### S5 — Build `JsonRpcClient`

`packages/protocol/src/transport/json-rpc-client.ts` (~150 LOC). Spec in §3.1.

**Internal state:** counter `Ref.Ref<number>`, pending `Ref.Ref<HashMap<JsonRpcId, Deferred>>`. Scope-bound; closing the scope drains pending via `failAllPending(NotConnectedError)`.

**Notification dispatch:** registered subscribers (`NotificationSubscriber<D>`) keyed by definition reference. `handleNotification` validates against `definition.validateParams`, fails closed on unknown method or invalid params.

**Acceptance:** unit tests in `transport/json-rpc-client.test.ts` covering:
- Happy path: call → response → resolve
- Timeout: call → no response → `RpcTimeoutError`
- Early disconnect: call mid-flight → finalizer → `NotConnectedError`
- Tagged-error decoding: response.error.code → matched descriptor.errorByCode → typed throw of `Method.errors.X`
- Unmatched code: response.error.code unknown → falls back to `RpcServerError`
- Unknown notification: `handleNotification` → `Effect.fail(UnknownNotificationMethodError)`
- Invalid notification params: `handleNotification` → `Effect.fail(InvalidNotificationParamsError)`

### S6 — Migrate 3 RPC-roundtrip callsites

**S6a — Client (`packages/client/src/ws-client.ts`):**
- Replace `sendRpcTrackedEffect` body with `jsonRpcClient.call(...)`
- Initialize `jsonRpcClient` per-connection in connect path with `idPrefix: "rpc"`
- Reader fiber routes Response frames → `jsonRpcClient.resolve(frame)`; Notification frames → `jsonRpcClient.handleNotification(frame)`
- Disconnect-finalizer calls `failAllPending`
- **Removes ~85 LOC. Replaces with ~10.**

**S6b — Server appCallback (`packages/server/src/ws/connection.ts`):**
- Replace `sendAppCallback` body with `connectionState.jsonRpcClient.call(...)`
- Connection-state holds JsonRpcClient created with `idPrefix: \`srv-${connId}\``
- Replace `acquireAppCallbackConnectionState` + `drainPendingWithAppDisconnected` with registry's Scope-bound finalizer
- `completeAppCallbackResponse` → `jsonRpcClient.resolve`
- **Removes ~95 LOC. Replaces with ~15.**

**S6c — Test client (`packages/protocol/src/testing/test-client.ts`):**
- Replace `sendRpc` with `jsonRpcClient.call`
- `sendMalformed` keeps bespoke shape (writes intentionally malformed frames; doesn't go through registry)
- **Removes ~50 LOC. Replaces with ~10.**

### S7 — Build `JsonRpcServer`

`packages/protocol/src/transport/json-rpc-server.ts` (~200 LOC). Spec in §3.2.

**Internals:**
- Build `Map<JsonRpcMethod, RpcHandler>` at construction
- `handle(frame, ctx)`:
  - Lookup method in handler map
  - If absent: `MethodNotFound` response (uses JSON_RPC_RESERVED_CODES)
  - If present: validate params via descriptor → `InvalidParams` response on fail
  - Run `handler.handle(params, ctx)` wrapped in `catchTag` calls (one per declared error tag) that map each → wire error response via descriptor.errorByCode
  - On unhandled defect: `InternalError` response, log with stack
  - On success: result response

**Acceptance:** unit tests in `transport/json-rpc-server.test.ts`:
- Happy path: handler returns Result → result response with right id
- Method not found → -32601 response
- Invalid params (schema fail) → -32602 response
- Tagged-error failure → wire error response with right code
- Defect (unhandled throw) → -32603 response, log captured
- Cross-cutting `RpcFailure` (Unauthorized, etc.) passes through unchanged (it's already a wire-error envelope)

### S8 — Migrate inbound dispatch to JsonRpcServer

Server's `handleFrame` Match.tag("Request") branch reduces to:

```ts
Match.tag("Request", ({ frame }) =>
  jsonRpcServer.handle(frame, { authenticated: conn.auth, connId }).pipe(
    Effect.flatMap(sendFrame),
  ),
)
```

**Files deleting in this step:**
- `server/src/rpc/router.ts` — body absorbed by JsonRpcServer
- `server/src/rpc/context.ts:makeRpcMethodBoundaryService` — decode logic moves into JsonRpcServer
- `server/src/rpc/dispatch.ts` (if exists)
- `protocol/transport/rpc-groups.ts:decodeRpcRequest` — folded into JsonRpcServer
- `protocol/transport/rpc-groups.ts:RpcBoundaryService` / `makeRpcBoundaryService` — already-dead surface (no consumers per grep)

**Files retaining bits of `rpc-groups.ts`:**
- `defineRpcGroup` / `defineNotificationGroup` — pure type containers used by `rpc-registry.ts`. Move to `transport/method.ts`.
- `RawDecodedNotification` / `DecodedNotification` types — survive (now without the Raw/Unknown discrimination since fail-close removes Unknown). Move to `method.ts`.

**External consumers of `decodeNotification` outside server's request-dispatch:** 6 sites (per grep)
- `client/test-utils/fake-service.ts` 
- `openclaw-channel/mapping.ts`
- `protocol/rpc-registry.ts` (forwarder export)
- `protocol/testing/test-client.ts`
- `protocol/testing/conformance/network/_helpers.ts` (post Phase 1A reorg; was `presence.ts`)

These migrate to a thin `decodeNotificationByName(method, params): Effect<DecodedNotification<D>, ...>` helper exported from `method.ts`. Same fail-close semantics as JsonRpcClient's `handleNotification` — unknown method → `Effect.fail(UnknownNotificationMethodError)`.

### S9 — Notification fail-close + type collapse

In `client/src/runtime/frame.ts` (or wherever the notification path lives post-S6a):

```ts
// Old (passthrough):
if (definition !== undefined) {
  return Effect.succeed(parsed as RawDecodedNotification<...>);
}
return Effect.succeed(parsed as UnknownDecodedNotification);

// New (fail-close):
if (definition === undefined) {
  return Effect.fail(new UnknownNotificationMethodError({ method: parsed.method }));
}
if (!definition.validateParams(parsed.params)) {
  return Effect.fail(new InvalidNotificationParamsError({ method: parsed.method, definition }));
}
return Effect.succeed({ ..., definition, _tag: "Notification" });
```

**Type collapse:**
- `RawDecodedNotification<D>` and `UnknownDecodedNotification` types DELETE
- Single `DecodedNotification<D>` shape: `{ _tag: "Notification"; definition: D; method: D["name"]; params: NotificationParamsOf<D>; ... }`
- `subscribers.ts` lift-from-Raw machinery DELETES (input is already validated)
- `notification-types.types-check.ts` canary DELETES (no discrimination to test)
- `service.handleNotification` lift call DELETES

**#437 closes here.** Issue resolved by deletion of weakening rather than re-tightening of validation; closes more decisively than the issue body asked.

### S10 — Collapse `transport/` to 4 files

After S2-S9, file consolidation is mostly trivial concat + import-rewrite per §3.9.

**Order:**
1. Create `transport/wire.ts` — concatenate `json-rpc.ts` + `frames.ts` (post-decodeFrame-Effect-shape) + JSON-RPC reserved codes from `errors.ts` + cross-cutting codes from `errors.ts` + `RpcErrorSchema` from `errors.ts` + (decision: ajv inline or stay separate based on size)
2. Create `transport/method.ts` — concatenate `rpc.ts` + `notification.ts` + `transport.ts` + `defineRpcGroup`/`defineNotificationGroup` from `rpc-groups.ts` + decoded-notification types from `rpc-groups.ts` + `decodeNotificationByName` helper
3. Verify imports across packages still resolve (build green per package)
4. Delete `transport/{frames.ts, frames.test.ts, errors.ts, json-rpc.ts, notification.ts, rpc.ts, rpc-groups.ts, transport.ts, index.ts}` — 9 deletions
5. Update `protocol/src/index.ts` to explicit allowlist (no `transport/*` re-exports through index.ts)
6. Split `transport/frames.test.ts` between `wire.test.ts` (frame-decode-on-crafted-bytes; survives) and trim builder-output-shape tests (deleted per §3.10)

**Net `transport/` LOC:** 1208 → ~700.

### S11 — Namespace-introspection wire-method-name union

In `protocol/src/rpc-registry.ts`:

```ts
import * as identityMethods from "./identity/methods/index.js";
import * as networkMethods from "./network/methods/index.js";
import * as taskMethods from "./task/methods/index.js";
import * as appMethods from "./app/methods/index.js";

type AllRpcDefinitions =
  | typeof identityMethods[keyof typeof identityMethods]
  | typeof networkMethods[keyof typeof networkMethods]
  | typeof taskMethods[keyof typeof taskMethods]
  | typeof appMethods[keyof typeof appMethods];

type RpcMethodName = AllRpcDefinitions extends RpcDefinition<infer N, any, any, any> ? N : never;
```

Replaces explicit `Connect | Register | ...` unions. Adding a new method requires only adding the descriptor to its module's exports — no manual union update.

### S12 — Verify + close issue evidence comments

After PR opens (or merges):
- **#437**: comment with link to S9 deletion of passthrough + the positive `UnknownNotificationMethodError` test. Close.
- **#405-#407, #409-#411**: comments mapping each acceptance criterion to merged work. Close immediately on PR open.
- **#408, #412**: verify comments after PR merges; close.

### S13 — Pre-PR gates

Per safer:implement-staff doctrine:
- `pnpm -r build` (typecheck)
- `pnpm -r lint`
- `pnpm -r format:check`
- `pnpm --filter @moltzap/protocol test:divergence-proofs`
- `pnpm -r test` (unit)
- `pnpm --filter @moltzap/server test:integration`
- `pnpm --filter @moltzap/client test:conformance`
- `/simplify` pass; apply all findings
- `/codex --mode review --diff HEAD` pass; post verdict on #452

## 6. Final-state file inventory

```
packages/protocol/src/
  index.ts                                  — explicit allowlist (no transport/* re-export through index)
  transport/
    wire.ts                                 — JsonRpc constants + frames + AJV + reserved/transport codes
                                              + cross-LAYER shared error classes (~300 LOC)
    method.ts                               — defineRpc + defineNotification + transport singleton + decoders
                                              + groups + decoded types (~250 LOC)
    json-rpc-client.ts                      — JsonRpcClient + makeJsonRpcClient (~150 LOC)
    json-rpc-server.ts                      — JsonRpcServer + makeJsonRpcServer with handle +
                                              dispatchNotification (~250 LOC)
    rpc-errors.ts                           — NotConnectedError, RpcTimeoutError, RpcServerError (~30 LOC)
    ajv.ts                                  — singleton (or inlined into wire.ts; S10 decision)
  identity.ts                               — Register, AgentsLookup, AgentsLookupByName, AgentsList,
                                              ContactsList/Add/Accept/ById, InvitesCreateAgent +
                                              ContactRequest/ContactAccepted notifications +
                                              AgentNotFoundError, NotInContactsError, BlockedError
                                              (used cross-layer; task imports from identity)
  network.ts                                — Connect, NetworkPing, PresenceUpdate, PresenceSubscribe
                                              + PresenceChanged notification
  task.ts                                   — MessagesSend, MessagesList, all conversations/* methods,
                                              all tasks/* methods + their notifications +
                                              TaskClosedError, ConversationArchivedError.
                                              IMPORTS AgentNotFoundError, NotInContactsError, BlockedError from identity.ts.
  app.ts                                    — AppsRegister, AppsAuthorizeDispatch + AppParticipantAdmitted/Rejected
                                              + AppNotFoundError, HookBlockedError
  rpc-registry.ts                           — namespace-introspection-derived unions
  testing/                                  — same structure; test-client uses JsonRpcClient/Server

packages/server/src/
  app/server.ts                             — handleFrame uses JsonRpcServer.handle + .dispatchNotification;
                                              ~40 LOC shorter
  rpc/                                      — DELETED (router.ts, context.ts absorbed by JsonRpcServer)
  ws/connection.ts                          — sendAppCallback uses JsonRpcClient; ~95 LOC shorter
  network|task|app/handlers/...             — error-raise sites use shared error classes
                                              (new AgentNotFoundError() etc.)
  runtime/errors.ts                         — DELETED. RpcFailure replaced by tagged classes
                                              in transport/wire.ts (UnauthorizedError, ForbiddenError,
                                              RateLimitedError, ProtocolMismatchError)

packages/client/src/
  ws-client.ts                              — sendRpcTracked uses JsonRpcClient; ~85 LOC shorter
  service.ts                                — error decoding via descriptor.errorByCode
                                              (replaces ad-hoc RpcServerError mapping)
  runtime/frame.ts                          — toDecodedFrame uses decodeFrame from protocol;
                                              notification path routes to JsonRpcServer.dispatchNotification
  runtime/subscribers.ts                    — no Raw→Decoded lift; subscribers receive
                                              validated DecodedNotification<D>
  test-utils/fake-service.ts                — uses JsonRpcServer.dispatchNotification

```

**Estimated total diff:** +1500 / -3500 net across protocol + server + client (larger than the original estimate; the per-layer file collapse + notifications co-location adds ~800 LOC of moves not previously counted).

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| **JsonRpcClient finalization races with disconnect.** Current `acquireAppCallbackConnectionState` finalizer drains pending; if registry-Scope and connection-Scope ordering is wrong, pending Deferreds leak. | M | Bind JsonRpcClient's Scope to a child of the connection's Scope; closing the connection's Scope auto-closes the registry's Scope which runs `failAllPending`. New integration test: "abrupt-close pending-call observes NotConnectedError." |
| **Per-method tagged errors break arena's wire-error-code matching** (arena reads `response.error.code` in `client/cli/transport.ts`). | L | Arena keeps existing `code → message` mapping; new tagged-error classes are additive on the in-repo client side. Run werewolf integration test against new client. |
| **Same code declared on multiple descriptors with mismatched messages.** | M | New divergence-proof test in S2: for every (code) appearing across descriptors, assert (message) agrees. Surfaces drift at PR-time. |
| **Notification re-validation rejects some payload that conformance suite expects.** | M | Conformance suite has fuzz coverage; if it goes red, tighten the descriptor's notification schema rather than relax the boundary. Retargeted assertion in S9 uses positive failure case. |
| **rpc-groups.ts external consumers (6 sites) break in subtle ways.** | M | Grep-based migration plan in S8; each consumer migrates explicitly with build + test gate per migration. |
| **Big diff (estimated +1200/-2700) makes review slow.** | H | Stack as 3 sub-commits in one PR for review staging: (1) prep cleanup S1, (2) descriptor errors + handler retag S2-S4, (3) JsonRpcClient/Server + file collapse S5-S11. CI runs end-to-end on each push. |
| **Context budget on this session running thin.** | H | Plan execution may need fresh sessions across S1-S13. Each step is independently executable + has explicit acceptance gates. Plan document is the handoff artifact. |
| **Conformance harness's `arbitraryNotificationFrame` paths break.** | H | Retarget those tests as positive `UnknownNotificationMethodError` assertions per S9. Some test code deletes outright (the `Raw|Unknown` discrimination tests from #455). |

## 8. NOT in scope (firm)

- **Other 8 packages' intra-module cleanup** stays in #453 (Phase 13). Protocol's `transport/` is pre-empted; everything else (server/, client/, channels, runtimes, app-sdk) is Phase 13's audit.
- **Doc refresh** beyond the wire renames already in flight stays in #454 (Phase 14).
- **`JsonRpcConnection` bidirectional bundling.** Each side of a connection holds a `JsonRpcClient` + `JsonRpcServer` instance; we are NOT introducing a wrapper that combines them. Future composition opportunity.
- **Arena consumer migration of new error tags.** Arena's typed-error catches use the existing wire-error-code mapping in `client/cli/transport.ts`. Per-method tagged errors are exposed to in-repo consumers; arena absorbs the new shape if/when it migrates. Plan §2.1 already established arena depends on `@moltzap/client` only; no submodule break.
- **Replacing `RpcFailure` entirely.** It survives for cross-cutting codes (Unauthorized, Forbidden, RateLimited, ProtocolMismatch) per Decision A2. These aren't method-specific; tag-per-descriptor doesn't fit.
- **`@moltzap/protocol` major version bump.** Surface changes are additive (new exports) + internal structural (file collapse). Type-level changes to descriptor shape (added `errors` field) are backward-compatible (defaults to `{}`). Minor bump sufficient.
- **AJV migration to a different validator** (Zod, Effect Schema, etc.). TypeBox + AJV remain canonical per #409 spec. Phase 12 doesn't relitigate.

## 9. Open questions for plan-eng-review

The plan is ready for review with these specific points worth pressure-testing:

1. **Decision A2** (handlers raise descriptor-tagged errors directly). Alternative A1 is lower-touch but keeps `RpcFailure` as universal envelope. Reviewer should confirm A2's ~40-handler-file churn is justified by the type-system gain.

2. **Decision E** (notification fail-close). Aggressive — collapses #455's machinery (`Raw|Unknown` discrimination) entirely. Reviewer should confirm no production caller depends on receiving unknown notification methods (grep evidence to be added).

3. **Issue absorption breadth.** Phase 12 closes 9 issues. Confirm none of #405-#412's acceptance criteria require *new* implementation — the position is "already implemented across phases 0-12, just needs evidence + close." Reviewer should spot-check a sample.

4. **JsonRpcClient finalizer timing.** §7 risk #1. The current `appCallbackPending` Ref drain is invoked on the connection-Scope's release; the new pattern relies on registry-Scope being a child. Reviewer should verify no race window where new pending entries register after registry finalization started.

5. **PR shape.** Single PR with 3 sub-commits vs 3 separate PRs. Plan chose single because the work is tightly coupled (handler retag depends on descriptor shape; JsonRpcClient depends on per-method errors for tagged-error decoding). Reviewer can challenge if review staging is degraded.

6. **Test deletion aggressiveness.** Plan deletes ~6 test files outright per §3.10. Reviewer should confirm that for each deletion, the type-side replacement is genuine (not just "it'll typecheck" hope).

## 10. Decision evolution (this session)

Folded into §3 above:

- 2026-05-06: User: "stop adding fucking narrative comments." → All Phase 12 prep work strips narrative comments from diffs.
- 2026-05-06: User: "delete the negative canary. that's fucking stupid." → SelectAgent type-canary deleted entirely (was an over-defensive type test).
- 2026-05-06: User pushed for "transport singleton" replacing `rpcMethods`/`notificationDefinitions` registries. → Decision F predecessor (transport.ts singleton with side-effect registration via `defineRpc`/`defineNotification`).
- 2026-05-06: User: "I don't like having rpc-registry and notification registry as two separate things." → Singleton consolidates both.
- 2026-05-06: User: "JsonRpcStringId/JsonRpcNumberId/JsonRpcId — why three?" → Collapsed to single `JsonRpcId`. Number variant had zero mint sites; nullability handled inline as `JsonRpcId | null` at builder/decode boundaries.
- 2026-05-06: User: "Frame builders accept plain strings; brand internally." → `requestFrame`/`responseFrame` take `string`/`string | null`; brand factory `jsonRpcId` deletes.
- 2026-05-06: User: "use catchTag instead of manually checking _tags." → `decodeFrame` becomes `Effect<DecodedFrame, FrameDecodeError>`; consumers use `Effect.catchTag` + `Match.discriminator` rather than `if (_tag === "X")` chains.
- 2026-05-06: User: "eww that code is ugly. refactor it properly." → Server `handleFrame` extracted into named helpers (`handleResponseFrame`, `dispatchResolved`, `fireConnectionHooks`, `handleRequestFrame`).
- 2026-05-06: User: "why should callers even be minting requestIds manually." → Decision A predecessor: ID-minting moves inside abstraction; brand never appears in caller code.
- 2026-05-06: User: "why is it called a registry and not something else?" → Rejected `RpcCaller`/`RpcDispatcher`/`RpcChannel`/`PendingRpcRegistry`; agreed on `JsonRpcClient`.
- 2026-05-06: User: "and I think we should also collapse a bunch of stuff. rpc.js, notifications.js, frames.js all should just be one tight file." → Decision F (4-file consolidation).
- 2026-05-06: User: "and do the same thing for JsonRpcServer." → §3.2 added.
- 2026-05-06: User: "right now all error codes are defined in one errors.ts? that also seems like a bad pattern." → Decision A + S2-S4 (per-method colocation).
- 2026-05-06: User: "why are you keeping passthroughs for unknowns rather than fail close?" → Decision E (notification fail-close).
- 2026-05-06: User: "if tests were doing the residual of what types should have been doing, then we should be moving things into types and clearing those tests." → §3.10 (Principle 1 test deletion list).

---

**Plan author:** phase-12-protocol-v2 teammate (this session)
**Ready for `/plan-eng-review`:** yes, after user confirms the decisions in §3.4 (A2), §3.5 (B1), §3.6 (C1), §3.8 (E) explicitly. (Decision D, F implicit from prior conversation.)

---

## Outcome (recorded after Phases 0–4 + doc sweep)

- Root facade reduced to 152 lines / 114 named exports (Phases 0–4
  complete, build + tests green).
- Decode entry collapsed to `decodeServerInbound` and
  `decodeClientInbound`. The free-function decode helpers
  (`decodeRpcParams`, `decodeRpcResult`, `decodeRpcCall`,
  `decodeRpcRequest`, `decodeNotification`, `decodeFrame`) are gone.
- Encode collapsed to per-definition methods (`Method.encodeRequest`,
  `Method.encodeResponse`, `Notification.encode`) plus
  `encodeErrorResponse` for method-agnostic error responses. The free
  functions `requestFrame`, `responseFrame`, `notificationFrame` are
  gone.
- `WIRE_CODES` and `ErrorCodes` aggregates retired; `JSON_RPC_RESERVED_CODES`
  now covers only the five JSON-RPC 2.0 reserved codes; per-class
  `static readonly code` is the single source of truth for handler
  errors.
- `ParamsOf<D>` / `ResultOf<D>` / `NotificationParamsOf<D>` wrappers
  retired; `typeof X.Params` / `typeof X.Result` (phantom carriers)
  replace them.
- `defineRpc` / `defineNotification` are no longer public; only
  protocol's own `methods.ts` files use them. Consumers bind via the
  new `handler(definition, fn)` factory; `RpcHandler<Ctx>` is
  de-generified.
- File layout restructured under `transport/`, `identity/`, `network/`,
  `task/`, `app/`, `testing/`. The flat `schema/` and `handlers/`
  directories are gone. Notifications are co-located with their
  methods in each layer's `methods.ts`. Branded-ID test-fixture
  constructors moved to `testing/branded-ids.ts`.
- Roughly 119 dead symbols dropped (`Invite*`, most legacy
  `Agent*Schema` / `Conversation*Schema`, task lifecycle notifications
  `TaskReady` / `TaskClosed` / `TaskAdmissionComplete`, the
  `App*Notification` family, and the error classes `Blocked`,
  `IdentityRejected`, `AgentNoOwner`, `AgentNotFound`,
  `MaxParticipants`, `AppNotFound`, `RateLimited`, `ProtocolMismatch`).
- Tooling: `scripts/generate-json-schema.ts` deleted (it referenced
  paths that no longer exist); `scripts/generate-protocol-docs.ts`
  updated to use `taskCallbackMethods` (the surviving registry export)
  and reruns clean against the new method set (41 methods + 9
  notifications + an overview page).
- Doc sweep: `docs/guides/app-hooks-rpc.mdx` and
  `docs/migration/webhook-to-rpc.mdx` retired (entirely about deleted
  hook RPCs / `@moltzap/app-sdk`); `docs/concepts/delivery.mdx`
  retired (delivery receipts + `messages/delivered` are gone).
  Architecture, server SDK, and concept pages updated to drop
  `Broadcaster` / `DeliveryService` / `messages/delivered` references
  and to point at `NetworkSendService` + `AgentEndpointResolver`
  instead. The error-code snippet now reflects the actual surviving
  classes (`-32000`, `-32001`, `-32002`, `-32003`, `-32005`, `-32007`,
  `-32019`, `-32020`, `-32022`).
