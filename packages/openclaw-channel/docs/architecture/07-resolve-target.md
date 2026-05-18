# `resolveTarget` Format and Error Shape

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`resolveTarget` appears in two distinct places with different callers:

**A. `messaging.targetResolver.resolveTarget` (directory resolver)**

```
Called by: OpenClaw's address-book pipeline
           (wired in `openclaw-entry.ts → messaging.targetResolver`)
Signature: resolveTarget(params) → Promise<Result | null>

params.normalized → isMoltZapTarget(normalized)?
  returns null     ← not our namespace; OpenClaw tries next resolver

  MOLTZAP_TARGET_RE = /^(agent|conv):.+$/   (in `openclaw-entry.ts`)
  matches: "agent:anything" or "conv:anything"

  on match → Promise.resolve({
    to:      normalized,
    kind:    conv:* → "group" | otherwise → "user",
    display: normalized.split(":").slice(1).join(":"),
              e.g. "agent:alice" → display "alice"
              e.g. "conv:abc-123" → display "abc-123"
    source:  "normalized"
  })
  No server round-trip; pure string parse.
```

**B. `outbound.resolveTarget` (send-time validation)**

```
Called by: OpenClaw before calling outbound.sendText
           (wired in `openclaw-entry.ts → outbound.resolveTarget`)
Signature: resolveTarget(params) → OpenClawTargetResolveResult
           (synchronous — no Promise)

params.to (after trim):
  ┌─ empty string ────────────────────────────────────────────────────┐
  │  return new OpenClawTargetRejected({                               │
  │    error: new Error("MoltZap: target is required")                 │
  │  })                                                                │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ contains ":" but fails isMoltZapTarget ──────────────────────────┐
  │  e.g. "slack:alice", "http://example.com"                          │
  │  return new OpenClawTargetRejected({                               │
  │    error: new Error(                                               │
  │      `MoltZap: unsupported target format "${to}"                   │
  │       — use agent:<name> or conv:<id>`)                           │
  │  })                                                                │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ passes isMoltZapTarget OR contains no ":" ────────────────────────┐
  │  (plain UUID without prefix — backward compat path)               │
  │  return new OpenClawTargetResolved({ to })                         │
  └──────────────────────────────────────────────────────────────────┘

Normalization table:
  "agent:alice"      → resolved, kind "user"   in targetResolver
                     → sendText branches agent: path
  "conv:abc-123"     → resolved, kind "group"  in targetResolver
                     → sendText branches conv: → slice prefix
  "abc-123"          → resolved (no colon → no rejection)
                     → sendText falls to plain-id path

Error shape:
  OpenClawTargetResolved  { _tag: "OpenClawTargetResolved",  ok:true,  to }
  OpenClawTargetRejected  { _tag: "OpenClawTargetRejected",  ok:false, error }
  Both extend Data.TaggedClass (effect Data module).
```

---

See also:
- [02-outbound-send-text.md](02-outbound-send-text.md) — sendText routing after resolveTarget succeeds
