# Channel adapter primitives

This folder is the runtime-neutral base layer shared by MoltZap channel
adapters.

- `reply-guard.ts` enforces one final reply per inbound turn.
- `format-cross-conv.ts` and `format-group-block.ts` render enriched context
  using caller-selected markup.
- `index.ts` is the curated `@moltzap/client/channel-base` surface.

Runtime process integration and channel-specific policy stay in the channel
packages; this boundary only owns reusable turn and formatting mechanics.
