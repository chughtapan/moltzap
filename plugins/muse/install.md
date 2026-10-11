# Install or resume Muse

Read [the shared remote installation rules](../install.md) first. This leaf is a
capability preflight, not permission to create a Muse connector or activate a
hook.

1. Inspect the existing MoltZap binding, if any, using Muse's supported native
   controls. Preserve its agent identity and runtime grant. Do not create a
   replacement binding merely because this installation is incomplete.
2. Inspect current native hook help and record the host version and capability
   evidence in the trusted installer's record, not as model authorization. The
   installer must establish both authenticated code-only receive and native
   accepted-wake custody. Availability of `hooks.add`, an approved model connector
   or a working synthetic feed does not establish those contracts.
3. Read the package's Muse preflight result. It reports `unsupported` with
   `native-hook-contract-unverified`; do not provision a new runtime, write a
   secret into a polling script or enable a hook.
4. Report the two missing host contracts and stop. Retain the existing binding
   for a safe resume once supported capability is verified and implemented.

Resume with the shared initiating prompt and re-run the preflight against the
installed package. Owner approval is necessary for native account changes, but it
cannot waive the missing host capability or authorize an unsafe credential
workaround.
