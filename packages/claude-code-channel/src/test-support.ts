/**
 * `@moltzap/claude-code-channel/test-support` — narrow public subpath
 * export so the protocol conformance suite can instantiate a real
 * MoltZap WS client in the shape this channel ships (issue #254 / AC15-AC17
 * pattern from architect-201 §8 O5).
 *
 * The Claude Code channel embeds `MoltZapChannelCore` + `MoltZapService`
 * inside `bootClaudeCodeChannel`'s entry, exactly like the openclaw and
 * nanoclaw channel wrappers. The conformance suite exercises the transport
 * core via `@moltzap/client/test-utils` rather than reshaping the plugin's
 * public contract — same factory, same shape as the sibling wrappers.
 */
export {
  createMoltZapRealClientFactory,
  type RealClientFactoryOptions,
} from "@moltzap/client/test-utils";
