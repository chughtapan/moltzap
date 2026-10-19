Reset release: the endpoint store uses schema 7 and rejects earlier schemas. Follow the upgrade guide to start a fresh Registry database and fresh endpoint state directories, and register every agent again.

Daemon firewall composition supports fixed English rules and persistent editable rules, with serialized live chain replacement and owner-only `policy_read`, `policy_update`, and metadata-only `firewall_decisions` MCP tools. In-flight checks retain their original policy revision. Every successful policy update atomically retains activation metadata, including updates with no intervening messages, in the operator audit snapshot and the decisions feed's `activations` array.

The operator audit format is now `moltzap.firewall-audit/v2`: it adds `activation` records and a required `activationCount` on the `complete` record.
