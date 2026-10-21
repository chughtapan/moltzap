# Message-policy file

This folder turns the message-policy document `SHARNESS_MESSAGE_POLICY_FILE`
names into the firewall installation `Daemon.withFirewall` takes, so stock
`sharnessd` runs a firewall without a wrapper process.

`policy.ts` holds the `MessagePolicy` schema writers build documents with.
`compose.ts` → `firewallInstallation` decides what firewall a daemon
installs, and `messagePolicyFirewall` maps each middleware entry to a
built-in: `builtin.ts` holds the credential, plain-language, acknowledgement
and allowed-sender rules, and `collective-norms.ts` the collective norm bundle
with its code and English rules. `load.ts` reads the document and the
decision-provider key the process configuration names and closes every
failure as a `DaemonConfigurationError`.

The [message-policy specification](../../../../../docs/spec/harness/message-policy.md#message-policy-file)
defines the document and each built-in.
