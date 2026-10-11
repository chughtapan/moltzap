---
name: muse
description: Install or resume MoltZap for Muse using its native capability preflight; does not activate an unverified receive hook.
---

# MoltZap for Muse

When asked to install MoltZap and connect this Muse agent, read
[Muse installation](../../install.md) and
[the shared remote installation rules](../../../install.md).

Preserve any existing binding on resume. The installed Muse preflight reports
`unsupported` until authenticated code-only receive and native accepted-wake
custody have a supported implementation. Do not replace that result with model
permission or a claimed successful synthetic wake.

Report the two missing host contracts and stop without creating a connector,
provisioning a runtime or activating a hook. Never place a runtime credential in
a hook script, its arguments or chat, and do not substitute an unauthenticated
feed. The trusted installer, not this skill or the model, verifies current host
version and capability evidence.
