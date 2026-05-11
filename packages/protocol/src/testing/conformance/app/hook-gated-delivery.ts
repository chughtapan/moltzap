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
 *   2. TM creates a GROUP conversation with sender and recipient as
 *      participants.
 *   3. TM closes its WS connection (goes offline → TM address
 *      `tm:agent:<tmAgentId>` has no live socket).
 *   4. Sender polls `messages/send` until the server-side
 *      `AgentEndpointResolver` has drained the TM entry: each attempt
 *      that succeeds means the TM is still live; the first
 *      `HookBlocked(-32019)` failure means the resolver is drained.
 *   5. Assert: the triggering send failed with `HookBlocked`.
 *   6. Assert: recipient's notification queue shows zero
 *      `messages/received` frames (delivery was prevented).
 *
 * The poll in step 4 replaces the previous wall-clock sleep
 * (`CLOSE_DRAIN_MS`). A sleep is not synchronized with the server-side
 * `AgentEndpointResolver` finalizer — CI showed 200 ms was insufficient,
 * causing `messages/send` to succeed when the resolver still held the
 * TM's entry. The poll exits on the first `HookBlocked` failure, which
 * by construction proves the resolver has drained.
 *
 * Anti-tautology: the poll CAN time out (if the TM stays live), in
 * which case the property fails with "resolver did not drain". The
 * predicate is not vacuous — CI confirms it fires with the wrong outcome
 * (success instead of HookBlocked) when the timing is insufficient.
 *
 * Phase-7-era arms dropped per #554:
 *   - `patch` arm (never in #560 design)
 *   - `apps/attachConversation` arm (deleted in Phase 7)
 *
 * Property ID: `delivery/hook-gated-delivery` (architect §7 — registry
 * category derives from the call-site, not the file path).
 */
import { Cause, Chunk, Effect, Exit } from "effect";
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
// Maximum number of send attempts while polling for HookBlocked.
const MAX_POLL_ATTEMPTS = 30;
// Interval (ms) between retry attempts when the TM resolver has not
// drained yet.
const POLL_INTERVAL_MS = 100;
// Window (ms) to collect stray notifications after the blocking send.
// Any messages/received frames that arrive within this window constitute
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

        // 2. TM opens a closeable WS client. The close method severs the
        //    WS connection, draining the server-side resolver entry for
        //    `tm:agent:<tmAgentId>`.
        const tmClient = yield* makeCloseableTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: tmAgent.apiKey,
          agentId: tmAgent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
        }).pipe(
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

        // 8. TM disconnects — closing the client's internal scope closes
        //    the WS socket and triggers the server-side resolver drain.
        //    After the finalizer runs, `tm:agent:<tmAgentId>` has no
        //    live ConnectionId. network.send → RecipientNotResolved →
        //    HookBlocked.
        yield* tmClient.close;

        // 9. Poll until the server-side AgentEndpointResolver has drained
        //    the TM entry. Each attempt that returns success means the
        //    resolver still holds the TM's connection — drain the
        //    recipient's queue (the message was delivered legitimately
        //    during this pre-block window) and retry. The first
        //    HookBlocked(-32019) failure is the synchronization barrier:
        //    it proves the resolver is drained and network.send returned
        //    RecipientNotResolved.
        let hookBlockedSeen = false;
        let attemptsLeft = MAX_POLL_ATTEMPTS;
        while (attemptsLeft > 0) {
          attemptsLeft -= 1;
          const attempt = yield* Effect.exit(
            senderClient.sendRpc(MessagesSend, {
              conversationId,
              parts: [{ type: "text", text: "should be blocked" }],
            }),
          );

          if (Exit.isSuccess(attempt)) {
            // TM resolver not yet drained — consume any pre-block
            // delivery notifications and retry.
            yield* recipientClient.drainNotifications;
            yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
            continue;
          }

          const rpcFailures = Chunk.toReadonlyArray(
            Cause.failures(attempt.cause),
          );
          const hookBlockedErr = rpcFailures.find(
            (f): f is RpcResponseError =>
              f instanceof RpcResponseError && f.code === HookBlockedError.code,
          );
          if (hookBlockedErr !== undefined) {
            hookBlockedSeen = true;
            break;
          }

          // Unexpected failure kind — the resolver drained but the error
          // is not HookBlocked; surface the raw cause.
          return yield* Effect.fail(
            violation(
              `messages/send failed with unexpected error (not HookBlocked(${HookBlockedError.code})): ` +
                `cause=${String(attempt.cause).slice(0, 300)}`,
            ),
          );
        }

        if (!hookBlockedSeen) {
          return yield* Effect.fail(
            violation(
              `server-side AgentEndpointResolver did not drain within ` +
                `${MAX_POLL_ATTEMPTS} attempts (${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS} ms); ` +
                `messages/send kept succeeding — TM resolver entry persisted`,
            ),
          );
        }

        // 10. Assert recipient received nothing after the blocking send.
        //     Drain after a brief window to collect any stray frames the
        //     server may have emitted concurrently with the block.
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
