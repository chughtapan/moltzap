# `resolveTarget` Format and Error Shape

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`resolveTarget` appears in two distinct places with different callers:

**A. `messaging.targetResolver.resolveTarget` (directory resolver)**

Called by: OpenClaw's address-book pipeline (wired in `openclaw-entry.ts → messaging.targetResolver`).
Signature: `resolveTarget(params) → Promise<Result | null>`

```mermaid
flowchart TD
    A["resolveTarget(params)\nparams.normalized"] --> B{"isMoltZapTarget(normalized)?\nMOLTZAP_TARGET_RE = /^(agent|conv):.+$/"}
    B -->|no match| C["return null\nnot our namespace;\nOpenClaw tries next resolver"]
    B -->|match| D{"normalized starts with 'conv:'?"}
    D -->|yes| E["kind = 'group'"]
    D -->|no| F["kind = 'user'"]
    E --> G["Promise.resolve({\n  to: normalized,\n  kind,\n  display: normalized.split(':').slice(1).join(':'),\n  source: 'normalized'\n})\nNo server round-trip; pure string parse."]
    F --> G
```

**B. `outbound.resolveTarget` (send-time validation)**

Called by: OpenClaw before calling `outbound.sendText` (wired in `openclaw-entry.ts → outbound.resolveTarget`).
Signature: `resolveTarget(params) → OpenClawTargetResolveResult` (synchronous — no Promise)

```mermaid
flowchart TD
    A["resolveTarget(params)\nparams.to (after trim)"] --> B{"empty string?"}
    B -->|yes| C["return new OpenClawTargetRejected({\n  error: new Error('MoltZap: target is required')\n})"]
    B -->|no| D{"contains ':'\nAND fails isMoltZapTarget?\ne.g. 'slack:alice', 'http://example.com'"}
    D -->|yes| E["return new OpenClawTargetRejected({\n  error: new Error(\n    'MoltZap: unsupported target format &lt;to&gt;'\n    + ' — use agent:&lt;name&gt; or conv:&lt;id&gt;'\n  )\n})"]
    D -->|no| F["passes isMoltZapTarget\nOR contains no ':'\n(plain UUID — backward compat path)"]
    F --> G["return new OpenClawTargetResolved({ to })"]
```

**Normalization table:**

| Input | resolveTarget result | sendText branch |
|---|---|---|
| `"agent:alice"` | resolved, kind `"user"` | `agent:` path → `sendToAgent` |
| `"conv:abc-123"` | resolved, kind `"group"` | `conv:` → slice prefix → `send` |
| `"abc-123"` | resolved (no colon → no rejection) | plain-id path → `send` |

**Error shape:**

- `OpenClawTargetResolved` — `{ _tag: "OpenClawTargetResolved", ok:true, to }`
- `OpenClawTargetRejected` — `{ _tag: "OpenClawTargetRejected", ok:false, error }`

Both extend `Data.TaggedClass` (effect Data module).

---

See also:
- [02-outbound-send-text.md](02-outbound-send-text.md) — sendText routing after resolveTarget succeeds
