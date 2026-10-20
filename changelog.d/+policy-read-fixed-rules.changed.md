The daemon MCP tool `policy_read` returns the agent's fixed firewall rules
readably: `fixedRules` replaces `fixedRuleIds` and lists each fixed rule once,
as `{from: "english", id, kind, text, guidance?, feedback?}` for a fixed English
rule or `{from: "code", middleware, id, kind, guidance?, feedback?}` for a rule a
code middleware declares. Fixed rules stay immutable; `policy_update` still
refuses their ids with `fixed-rule`. Consumers reading `fixedRuleIds` read
`fixedRules[].id` instead.
