/**
 * Hook-gated delivery — TM-offline Block prevents recipient delivery.
 *
 * #560 landed `messages/authorize` semantics via `network.send` routing:
 *   - `messages/send` writes a `messages/received` frame to the
 *     conversation's `tm_endpoint_address` via `network.send`.
 *   - If the TM agent is offline, `network.send` returns
 *     `RecipientNotResolved`, which the message-service maps to
 *     `RpcFailure(HookBlocked, code=-32019)`.
 *   - The broadcast to conversation participants is gated AFTER the TM
 *     route: a blocked TM route means no recipient delivery.
 *
 * Property: Block-prevents-delivery
 *   1. TM creates task bound to itself (`tmType: "self"`).
 *   2. TM creates a DM conversation with a separate recipient agent.
 *   3. TM closes its WS connection (goes offline → TM address
 *      `tm:agent:<tmAgentId>` has no live socket).
 *   4. Sender (a third agent, participant in the conversation) calls
 *      `messages/send`.
 *   5. Assert: `messages/send` fails with `RpcFailure` code
 *      `HookBlockedError.code` (-32019).
 *   6. Assert: recipient's notification queue shows zero
 *      `messages/received` frames (delivery was prevented).
 *
 * Phase-7-era arms dropped per #554:
 *   - `patch` arm (never in #560 design)
 *   - `apps/attachConversation` arm (deleted in Phase 7)
 *
 * Property ID: `delivery/hook-gated-delivery` (architect §7 — registry
 * category derives from the call-site, not the file path).
 */
import { Cause, Chunk, Effect, Exit, Scope } from "effect";
import type { Static } from "@sinclair/typebox";
import {
  TasksCreate,
  TasksCreateConversation,
  TasksAddParticipant,
  MessagesSend,
  HookBlockedError,
  MessageReceivedNotificationDefinition,
  ConversationId,
  TaskId,
} from "@moltzap/protocol/task";
import { agentId as brandAgentId } from "@moltzap/protocol/testing";
import { RpcResponseError } from "../_shared/errors.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import {
  makeCloseableTestClient,
  makeTestClient,
} from "../_shared/driver/test-client.js";

const CATEGORY = "delivery" as const;
const PROPERTY = "hook-gated-delivery";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_CAPACITY = 64;
// Grace period (ms) for the WS finalizer to drain the resolver after
// close — mirrors the 100 ms used in the integration suite.
const CLOSE_DRAIN_MS = 200;
// Window to collect stray notifications after the blocked send. Any
// messages/received frames that arrive within this window constitute
// a delivery-prevention violation.
const DRAIN_WINDOW_MS = 300;
function violation(reason: string): PropertyInvariantViolation {
  return new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });
}

export function registerHookGatedDelivery(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "TM offline ⇒ messages/send fails HookBlocked; recipient receives nothing",
    Effect.scoped(
      Effect.gen(function* () {
        // 1. Register three agents: TM (task-manager), sender, recipient.
        //    registerTestAgent appends its own timestamp+random suffix so
        //    short prefix names are safe across concurrent property runs.
        const acquireAgent = (name: string) =>
          registerTestAgent({
            baseUrl: ctx.realServer.baseUrl,
            name,
          }).pipe(
            Effect.mapError((e) =>
              violation(
                `agent register (${name}): status=${e.status} body=${e.body}`,
              ),
            ),
          );

        const tmAgent = yield* acquireAgent("hgd-tm");
        const senderAgent = yield* acquireAgent("hgd-sndr");
        const recipientAgent = yield* acquireAgent("hgd-rcpt");

        // 2. TM opens a closeable WS client (closeable so step 5 can
        //    sever the connection programmatically without waiting for
        //    scope teardown).
        const tmScope = yield* Scope.make();
        const tmClient = yield* Scope.extend(
          makeCloseableTestClient({
            serverUrl: ctx.realServer.wsUrl,
            agentKey: tmAgent.apiKey,
            agentId: tmAgent.agentId,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            captureCapacity: DEFAULT_CAPTURE_CAPACITY,
          }),
          tmScope,
        ).pipe(
          Effect.mapError((e) => violation(`TM client acquire: ${String(e)}`)),
        );

        // 3. Sender client (open for the duration of the property).
        const senderClient = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: senderAgent.apiKey,
          agentId: senderAgent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
          Effect.mapError((e) =>
            violation(`sender client acquire: ${String(e)}`),
          ),
        );

        // 4. Recipient client (open for the duration of the property).
        const recipientClient = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: recipientAgent.apiKey,
          agentId: recipientAgent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
          Effect.mapError((e) =>
            violation(`recipient client acquire: ${String(e)}`),
          ),
        );

        // 5. TM creates task bound to itself (`tmType: "self"`). The
        //    server resolves the caller's authenticated agent id as the
        //    TM endpoint address (Phase 9b round 4 R16).
        const taskResult = yield* tmClient
          .sendRpc(TasksCreate, { tmType: "self" })
          .pipe(
            Effect.mapError((e) => violation(`tasks/create: ${e.message}`)),
          );
        const taskId = (taskResult as { task: { id: Static<typeof TaskId> } })
          .task.id;

        // 6. Add sender + recipient as participants on the task.
        yield* tmClient
          .sendRpc(TasksAddParticipant, {
            taskId,
            agentId: brandAgentId(senderAgent.agentId),
          })
          .pipe(
            Effect.mapError((e) =>
              violation(`tasks/addParticipant (sender): ${e.message}`),
            ),
          );
        yield* tmClient
          .sendRpc(TasksAddParticipant, {
            taskId,
            agentId: brandAgentId(recipientAgent.agentId),
          })
          .pipe(
            Effect.mapError((e) =>
              violation(`tasks/addParticipant (recipient): ${e.message}`),
            ),
          );

        // 7. TM creates a GROUP conversation containing both sender and
        //    recipient so sender can send and recipient is reachable for
        //    the delivery-prevention assertion.
        const convResult = yield* tmClient
          .sendRpc(TasksCreateConversation, {
            taskId,
            type: "group",
            name: "hgd-conv",
            participants: [
              { type: "agent", id: senderAgent.agentId },
              { type: "agent", id: recipientAgent.agentId },
            ],
          })
          .pipe(
            Effect.mapError((e) =>
              violation(`tasks/createConversation: ${e.message}`),
            ),
          );
        const conversationId = (
          convResult as { conversation: { id: Static<typeof ConversationId> } }
        ).conversation.id;

        // 8. TM disconnects — TM's WS close triggers resolver drain.
        //    After the finalizer runs, `tm:agent:<tmAgentId>` has no
        //    live ConnectionId. network.send → RecipientNotResolved →
        //    HookBlocked. Closing the inner scope is equivalent to
        //    hard-close on the WS.
        yield* Scope.close(tmScope, Exit.void);
        // Brief grace period for the server-side finalizer to drain the
        // resolver map before the sender fires messages/send.
        yield* Effect.sleep(`${CLOSE_DRAIN_MS} millis`);

        // 9. Sender fires messages/send. The server resolves
        //     conversationId → task.tm_endpoint_address = tm:agent:<tmId>
        //     → resolver.resolveAll(tmId) → empty set (TM offline) →
        //     RecipientNotResolved → HookBlocked.
        const sendOutcome = yield* Effect.exit(
          senderClient.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "should be blocked" }],
          }),
        );

        if (Exit.isSuccess(sendOutcome)) {
          return yield* Effect.fail(
            violation(
              "messages/send succeeded despite TM being offline; " +
                "expected RpcFailure(HookBlocked)",
            ),
          );
        }

        // Extract the typed RpcResponseError from the exit cause and
        // assert it carries HookBlocked's wire code. Using Cause.failures
        // (same pattern as _driver.ts firstRpcResponseError) avoids
        // stringly-typed cause inspection.
        const rpcFailures = Chunk.toReadonlyArray(
          Cause.failures(sendOutcome.cause),
        );
        const hookBlockedErr = rpcFailures.find(
          (f): f is RpcResponseError =>
            f instanceof RpcResponseError && f.code === HookBlockedError.code,
        );
        if (hookBlockedErr === undefined) {
          return yield* Effect.fail(
            violation(
              `messages/send failed but not with HookBlocked(${HookBlockedError.code}); ` +
                `cause=${String(sendOutcome.cause).slice(0, 300)}`,
            ),
          );
        }

        // 10. Assert recipient received nothing. Drain after a brief
        //     window to collect any stray frames the server may have
        //     emitted before the block took effect.
        yield* Effect.sleep(`${DRAIN_WINDOW_MS} millis`);
        const strayFrames = yield* recipientClient.drainNotifications;
        const receivedCount = strayFrames.filter(
          (n) => n.method === MessageReceivedNotificationDefinition.name,
        ).length;

        if (receivedCount > 0) {
          return yield* Effect.fail(
            violation(
              `recipient observed ${receivedCount} messages/received frame(s) ` +
                `after a TM-blocked send; delivery was not prevented`,
            ),
          );
        }
      }),
    ),
  );
}
