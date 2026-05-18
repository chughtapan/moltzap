# 08 — Channel-base subpath

> Status: outline (architect stub — impl-staff fills bodies per arch sub-issue
> #605 §10 sequencing).

The `@moltzap/client/channel-base` subpath is the shared scaffolding layer for
the three channel adapters (`openclaw-channel`, `claude-code-channel`,
`nanoclaw-channel`). It hosts the canonical `LeaseAlreadyConsumed` tagged
error, the `LeaseStore` / `LeaseGuard` lease lifecycle primitives, and the
markup-parameterized cross-conv + group-block formatters.

Spec: #597. Architect plan: #605. Parent epic: #602.

## 1. Goals

(impl-staff fills — restate the four-bullet goal list from the spec for
reader self-containment, including the C1/C1-α/C2/C3 decisions.)

## 2. Primitives

(impl-staff fills — one paragraph per exported symbol: `LeaseAlreadyConsumed`,
`projectLeaseInvalid`, `catchLeaseInvalid`, `LeaseStore`, `LeaseGuard`,
`formatCrossConv`, `formatGroupBlock`, `getGroupFields`. Cite by symbol name
per workspace-root `CLAUDE.md` doc-maintenance rule — no line numbers.)

## 3. Lease projection sequence (Mermaid)

(impl-staff fills — Mermaid sequenceDiagram showing the wire-error path from
`messages/send` → server `LeaseInvalidError` → `ForbiddenError` (-32001) →
client `RpcServerError` → `catchLeaseInvalid` → `LeaseAlreadyConsumed`. Then
the three branches:
  - claude-code: `server.ts → toolErrorResult(...)`
  - openclaw: deliver wrapper → `onLeaseConsumed?` → return false
  - nanoclaw: `MoltZapChannel.sendMessage` → Effect raises typed error

Validate via the local Mermaid parser loop per workspace-root `CLAUDE.md` —
GitHub's renderer rejects `<br/>` (use `<br>`) and `;` inside `Note over X: …`.)

## 4. Per-channel worked examples

(impl-staff fills — three code blocks showing the import-site change for each
channel. Include the `onLeaseConsumed` opt-in for openclaw.)

## 5. Why no high-level `createChannelBase` helper (OQ2 = A)

(impl-staff fills — restate the OQ2 = A resolution: ship primitives only.
Channels stay free to wire their own surfacing path; a higher-level helper
would obscure the per-host contract differences that are deliberate per
spec §"Non-goals" #4 and §"Invariants".)

## 6. See also

- Spec: chughtapan/moltzap#597
- Architect plan: chughtapan/moltzap#605
- `packages/openclaw-channel/docs/architecture/05-deliver-error-handling.md`
- `packages/nanoclaw-channel/docs/architecture/04-outbound-send-message.md`
- `packages/claude-code-channel/docs/architecture/04-lease-state-machine.md`
