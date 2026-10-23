# Firewall policy

`policy.ts` holds the `MessagePolicy` document schema. `load.ts` reads the
policy document, decision-provider key and audit destination. `compose.ts`
constructs the installed middleware chains from the document and built-in
rules in `../rules/`. `configuration.ts` names the file locations and error
constructor supplied by the daemon. `editable.ts` persists owner edits before
swapping immutable active chains.

See the [message-policy specification](https://github.com/social-harness/moltzap/blob/main/docs/spec/harness/message-policy.md#message-policy-file).
