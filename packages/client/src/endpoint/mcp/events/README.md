# Daemon Events

This folder owns MCP Events discovery and the shared consumer boundary for
local push, authenticated polling and signed webhooks. The coordinator in
`index.ts` serializes acquisition and revocation with exact-token receipt work.
Transport-specific lease and retry state stays private to this folder.

Item framing comes from the pure `endpoint/event-contract` facade. Only this
daemon edge resolves retained inbox rows and persists webhook occurrences.
Callback I/O happens outside the consumer ownership gate; a native receipt's
persistence remains inside that gate until completion or cancellation cleanup.
