Stock `sharnessd` installs a message firewall from a policy file, so a
deployment no longer needs its own daemon program for one.
`SHARNESS_MESSAGE_POLICY_FILE` names an
`org.social-harness/message-policy/v1` document: the firewall mode, built-in
code middleware for each direction (`acknowledgements`, `allowed-senders`,
`credentials`, `plain-language` and the `collective-norms` bundle), fixed and
initial editable English rules, the decision provider, and check bounds.
`SHARNESS_DECISION_PROVIDER_KEY_FILE` holds the key of a `jev` decision
provider, and `SHARNESS_FIREWALL_AUDIT_EXPORT` publishes the firewall audit on
graceful shutdown. Unset, the daemon runs without a firewall as before.
`@moltzap/client/service` exports `MessagePolicy` for writers and
`messagePolicyFirewall` for compositions that supply their own decision
provider.
