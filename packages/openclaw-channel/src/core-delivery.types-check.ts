/**
 * @file OpenClaw's core text delivery carries no message-tool parameters. A
 * send that OpenClaw forces through core delivery (`forceCoreDelivery` or
 * `requireQueuePersistence`) reaches `message.send.text` with its target and
 * text alone, so it can never carry `collective` or `collectiveResponse` and a
 * gather can never arrive there. OpenClaw 2026.8.1 forces core delivery only
 * for the conversations tool and plugin delivery, which build their sends
 * from text and media; the message tool's own `send`, the one path that
 * carries the parameters, reaches `actions.handleAction`. If OpenClaw adds a
 * parameter bag to this context, this canary fails, and `message.send.text`
 * must then refuse a send that names a collective operation rather than
 * certify it as a multicast.
 */

import type { ChannelMessageSendTextContext } from "openclaw/plugin-sdk/channel-outbound";

type Expect<Value extends true> = Value;

type ToolParameterKeys = Extract<
  keyof ChannelMessageSendTextContext,
  "params" | "payload" | "collective" | "collectiveResponse"
>;

type CoreTextDeliveryCarriesNoToolParameters = Expect<
  [ToolParameterKeys] extends [never] ? true : false
>;

/** Compile-time witnesses for the OpenClaw delivery paths this adapter relies on. */
export type CoreDeliveryCanaries = [CoreTextDeliveryCarriesNoToolParameters];
